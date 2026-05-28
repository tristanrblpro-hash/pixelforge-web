"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PromptBar } from "./PromptBar";
import { Gallery, GalleryItem } from "./Gallery";

type ImageModelInfo = {
  key: string;
  label: string;
  vendor: string;
  aspectRatios: string[];
  pricePerImage: number;
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
  itemIds: string[]; // pre-allocated item placeholders before first poll
};

export function HomeStudio({ models, initialItems }: Props) {
  const [items, setItems] = useState<GalleryItem[]>(initialItems);
  const [active, setActive] = useState<ActiveBatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

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
      count: number;
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
      <Gallery items={items} />
      <PromptBar models={models} busy={busy} onSubmit={handleSubmit} />
    </>
  );
}
