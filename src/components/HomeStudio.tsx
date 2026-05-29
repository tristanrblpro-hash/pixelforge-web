"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PromptBar } from "./PromptBar";
import { Gallery, GalleryItem } from "./Gallery";
import { ImagePreviewModal } from "./ImagePreviewModal";

type ImageModelInfo = {
  key: string;
  label: string;
  vendor: string;
  aspectRatios: string[];
  qualities: string[];
  pricing: Record<string, number>;
  defaultPricePerImage: number;
  pricingNote?: string;
  maxInputImages: number;
  badge?: "TOP" | "NEW" | "SOON";
};

type Props = {
  models: ImageModelInfo[];
  initialItems: GalleryItem[];
};

type ActiveBatch = {
  batchId: string;
  prompt: string;
  modelKey: string;
  aspectRatio: string;
  quality: string;
  itemIds: string[];
};

// sessionStorage handoff slot. The Prompts page writes a payload here right
// before navigating to "/", and HomeStudio drains it on mount to prefill the
// PromptBar and (optionally) auto-run a generation.
const HANDOFF_KEY = "pf:nanoHandoff";

type HandoffPayload = {
  prompt: string;
  modelKey?: string;
  autorun?: boolean;
  ts?: number;
};

export function HomeStudio({ models, initialItems }: Props) {
  const [items, setItems] = useState<GalleryItem[]>(initialItems);
  const [active, setActive] = useState<ActiveBatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GalleryItem | null>(null);
  const [initialPrompt, setInitialPrompt] = useState<string | undefined>(undefined);
  const [initialModelKey, setInitialModelKey] = useState<string | undefined>(undefined);
  const [autoSubmitToken, setAutoSubmitToken] = useState<string | null>(null);
  const pollers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  // Drain the sessionStorage handoff exactly once.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.sessionStorage.getItem(HANDOFF_KEY);
      if (!raw) return;
      window.sessionStorage.removeItem(HANDOFF_KEY);
      const payload = JSON.parse(raw) as HandoffPayload;
      if (typeof payload.prompt === "string" && payload.prompt.trim()) {
        setInitialPrompt(payload.prompt);
        if (payload.modelKey) setInitialModelKey(payload.modelKey);
        if (payload.autorun) setAutoSubmitToken(String(payload.ts || Date.now()));
      }
    } catch {
      /* ignore — handoff is best-effort */
    }
  }, []);

  const stopPolling = useCallback((batchId: string) => {
    const id = pollers.current.get(batchId);
    if (id) {
      clearInterval(id);
      pollers.current.delete(batchId);
    }
    setActive((prev) => prev.filter((b) => b.batchId !== batchId));
  }, []);

  const pollBatch = useCallback(
    async (batchId: string, ctx: ActiveBatch) => {
      try {
        const r = await fetch(`/api/batch/${batchId}/status`, { cache: "no-store" });
        if (!r.ok) return;
        const data = await r.json();
        const remoteItems = (data.items || []) as Array<{
          item_id: string;
          idx: number;
          status: GalleryItem["status"];
          output_url: string | null;
          error?: string | null;
        }>;

        setItems((prev) => {
          const map = new Map(prev.map((p) => [p.item_id, p]));
          for (const ri of remoteItems) {
            const existing = map.get(ri.item_id);
            const merged: GalleryItem = {
              item_id: ri.item_id,
              batch_id: batchId,
              idx: ri.idx,
              status: ri.status,
              output_url: ri.output_url,
              error: ri.error,
              prompt: existing?.prompt ?? ctx.prompt,
              aspect_ratio: existing?.aspect_ratio ?? ctx.aspectRatio,
              model_key: existing?.model_key ?? ctx.modelKey,
            };
            map.set(ri.item_id, merged);
          }
          return Array.from(map.values()).sort((a, b) => {
            // newer batches first; within a batch, idx ascending
            if (a.batch_id !== b.batch_id) {
              return (b.batch_id || "").localeCompare(a.batch_id || "");
            }
            return (a.idx ?? 0) - (b.idx ?? 0);
          });
        });

        const allTerminal = remoteItems.every(
          (i) => i.status === "done" || i.status === "failed",
        );
        if (allTerminal && remoteItems.length > 0) {
          stopPolling(batchId);
        }
      } catch {
        // swallow transient network errors — keep polling
      }
    },
    [stopPolling],
  );

  const handleSubmit = useCallback(
    async (input: {
      prompt: string;
      modelKey: string;
      aspectRatio: string;
      quality: string;
      count: number;
      inputUrls: string[];
    }) => {
      setBusy(true);
      setError(null);

      // Pre-insert N placeholder cards so the user sees immediate feedback
      // *before* the server returns. They'll be replaced on the first poll.
      const tempId = `tmp_${Date.now().toString(36)}`;
      const placeholders: GalleryItem[] = Array.from({ length: input.count }).map((_, idx) => ({
        item_id: `${tempId}_${idx}`,
        batch_id: tempId,
        idx,
        status: "queued",
        prompt: input.prompt,
        aspect_ratio: input.aspectRatio,
        model_key: input.modelKey,
      }));
      setItems((prev) => [...placeholders, ...prev]);

      try {
        const r = await fetch("/api/generate/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const data = await r.json();
        if (!r.ok) {
          setError(data.error || `HTTP ${r.status}`);
          setItems((prev) => prev.filter((it) => it.batch_id !== tempId));
          return;
        }

        const realBatchId = data.batch_id as string;
        const ctx: ActiveBatch = {
          batchId: realBatchId,
          prompt: input.prompt,
          modelKey: input.modelKey,
          aspectRatio: input.aspectRatio,
          quality: input.quality,
          itemIds: [],
        };
        setActive((prev) => [...prev, ctx]);
        // Drop placeholders; first poll will populate the real items.
        setItems((prev) => prev.filter((it) => it.batch_id !== tempId));

        // Poll every 4s
        const intervalId = setInterval(() => pollBatch(realBatchId, ctx), 4000);
        pollers.current.set(realBatchId, intervalId);
        // Fire one poll immediately so the cards appear ASAP.
        pollBatch(realBatchId, ctx);
      } catch (e) {
        setError(String(e));
        setItems((prev) => prev.filter((it) => it.batch_id !== tempId));
      } finally {
        setBusy(false);
      }
    },
    [pollBatch],
  );

  // Cleanup on unmount
  useEffect(() => {
    const cur = pollers.current;
    return () => {
      cur.forEach((id) => clearInterval(id));
      cur.clear();
    };
  }, []);

  const handleCancel = useCallback(async (itemId: string) => {
    // Optimistic remove: drop the item immediately. KIE keeps billing the job,
    // but the user no longer sees the placeholder.
    setItems((prev) => prev.filter((i) => i.item_id !== itemId));
    try {
      await fetch(`/api/item/${encodeURIComponent(itemId)}/cancel`, { method: "POST" });
    } catch {
      // best-effort — if the server call fails the item just won't be marked
      // cancelled in DB, but it's gone from the UI for this session.
    }
  }, []);

  return (
    <>
      {active.length > 0 && (
        <div className="mb-4 inline-flex items-center gap-2 bg-pf-elev border border-pf-border rounded-full px-3 py-1 text-xs text-pf-dim">
          <span className="w-2 h-2 rounded-full bg-pf-accent animate-pulse" />
          {active.length} batch{active.length > 1 ? "es" : ""} in progress
        </div>
      )}
      {error && (
        <div className="mb-4 bg-pf-elev border border-pf-danger rounded-lg px-4 py-2 text-sm text-pf-danger">
          {error}
        </div>
      )}
      <Gallery items={items} onCancel={handleCancel} onOpen={setPreview} />
      <PromptBar
        models={models}
        busy={busy}
        onSubmit={handleSubmit}
        initialPrompt={initialPrompt}
        initialModelKey={initialModelKey}
        autoSubmitToken={autoSubmitToken}
      />
      <ImagePreviewModal item={preview} onClose={() => setPreview(null)} />
    </>
  );
}
