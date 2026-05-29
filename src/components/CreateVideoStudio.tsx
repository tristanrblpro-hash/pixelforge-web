"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Sparkles, Loader2, ImagePlus, X, ChevronDown, Check, Volume2, VolumeX, RefreshCcw,
} from "lucide-react";
import { Gallery, type GalleryItem } from "./Gallery";
import { ImagePreviewModal } from "./ImagePreviewModal";
import { RatioIcon } from "./RatioIcon";

type QualityInfo = {
  label: string;
  displayLabel: string;
  resolution: string;
  pricePerSecondNoAudio: number;
  pricePerSecondWithAudio: number;
};

type VideoCreateModelInfo = {
  key: string;
  label: string;
  vendor: string;
  aspectRatios: string[];
  durations: number[];
  qualities: QualityInfo[];
  supportsEndFrame: boolean;
  supportsSound: boolean;
  pricingNote?: string;
};

type Props = {
  models: VideoCreateModelInfo[];
  initialItems: GalleryItem[];
};

type ActiveBatch = {
  batchId: string;
  prompt: string;
};

const LS_KEY = "pixelforge_video_create_inputs_v1";

type PersistedInputs = {
  startFrameUrl?: string | null;
  endFrameUrl?: string | null;
  prompt?: string;
  qualityLabel?: string;
  aspectRatio?: string;
  duration?: number;
  sound?: boolean;
};

function loadPersisted(): PersistedInputs {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function savePersisted(v: PersistedInputs) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(v));
  } catch {}
}

export function CreateVideoStudio({ models, initialItems }: Props) {
  const model = models[0];
  const qualities = model?.qualities ?? [];
  const ratios = model?.aspectRatios ?? ["9:16"];
  const durations = model?.durations ?? [5];

  const [startUrl, setStartUrl] = useState<string | null>(null);
  const [endUrl, setEndUrl] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [qualityLabel, setQualityLabel] = useState<string>(qualities[1]?.label ?? qualities[0]?.label ?? "Pro");
  const [aspectRatio, setAspectRatio] = useState<string>(ratios.includes("9:16") ? "9:16" : ratios[0]);
  const [duration, setDuration] = useState<number>(5);
  const [sound, setSound] = useState<boolean>(false);
  const [uploadingStart, setUploadingStart] = useState(false);
  const [uploadingEnd, setUploadingEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<GalleryItem[]>(initialItems);
  const [active, setActive] = useState<ActiveBatch[]>([]);
  const [preview, setPreview] = useState<GalleryItem | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const [qualityOpen, setQualityOpen] = useState(false);
  const [ratioOpen, setRatioOpen] = useState(false);
  const [durationOpen, setDurationOpen] = useState(false);

  const startInput = useRef<HTMLInputElement | null>(null);
  const endInput = useRef<HTMLInputElement | null>(null);
  const pollers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  const selectedQuality = qualities.find((q) => q.label === qualityLabel) ?? qualities[0];

  useEffect(() => {
    const p = loadPersisted();
    if (p.startFrameUrl) setStartUrl(p.startFrameUrl);
    if (p.endFrameUrl) setEndUrl(p.endFrameUrl);
    if (p.prompt) setPrompt(p.prompt);
    if (p.qualityLabel && qualities.some((q) => q.label === p.qualityLabel)) setQualityLabel(p.qualityLabel);
    if (p.aspectRatio && ratios.includes(p.aspectRatio)) setAspectRatio(p.aspectRatio);
    if (p.duration && durations.includes(p.duration)) setDuration(p.duration);
    if (typeof p.sound === "boolean") setSound(p.sound);
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    savePersisted({
      startFrameUrl: startUrl, endFrameUrl: endUrl, prompt,
      qualityLabel, aspectRatio, duration, sound,
    });
  }, [hydrated, startUrl, endUrl, prompt, qualityLabel, aspectRatio, duration, sound]);

  async function uploadFile(file: File): Promise<string> {
    const form = new FormData();
    form.append("file", file);
    const r = await fetch("/api/upload", { method: "POST", body: form });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data.url as string;
  }

  async function handleStartFile(files: FileList | null) {
    const f = files?.[0]; if (!f) return;
    setUploadingStart(true); setError(null);
    try { setStartUrl(await uploadFile(f)); }
    catch (e) { setError(String(e)); }
    finally { setUploadingStart(false); }
  }
  async function handleEndFile(files: FileList | null) {
    const f = files?.[0]; if (!f) return;
    setUploadingEnd(true); setError(null);
    try { setEndUrl(await uploadFile(f)); }
    catch (e) { setError(String(e)); }
    finally { setUploadingEnd(false); }
  }

  const stopPolling = useCallback((batchId: string) => {
    const id = pollers.current.get(batchId);
    if (id) { clearInterval(id); pollers.current.delete(batchId); }
    setActive((prev) => prev.filter((b) => b.batchId !== batchId));
  }, []);

  const pollBatch = useCallback(async (batchId: string, ctx: ActiveBatch) => {
    try {
      const r = await fetch(`/api/batch/${batchId}/status`, { cache: "no-store" });
      if (!r.ok) return;
      const data = await r.json();
      const remoteItems = (data.items || []) as Array<{
        item_id: string; idx: number; status: GalleryItem["status"];
        output_url: string | null; error?: string | null;
      }>;
      setItems((prev) => {
        const map = new Map(prev.map((p) => [p.item_id, p]));
        for (const ri of remoteItems) {
          const existing = map.get(ri.item_id);
          map.set(ri.item_id, {
            item_id: ri.item_id, batch_id: batchId, idx: ri.idx,
            status: ri.status, output_url: ri.output_url, error: ri.error,
            prompt: existing?.prompt ?? ctx.prompt,
            aspect_ratio: existing?.aspect_ratio ?? aspectRatio,
            model_key: existing?.model_key ?? model?.key,
          });
        }
        return Array.from(map.values()).sort((a, b) => (b.batch_id || "").localeCompare(a.batch_id || ""));
      });
      const allTerminal = remoteItems.every((i) => i.status === "done" || i.status === "failed");
      if (allTerminal && remoteItems.length > 0) stopPolling(batchId);
    } catch {}
  }, [aspectRatio, model?.key, stopPolling]);

  const handleGenerate = useCallback(async () => {
    if (!startUrl || !prompt.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/video/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startFrameUrl: startUrl, endFrameUrl: endUrl, prompt: prompt.trim(),
          modelKey: model?.key, qualityLabel, aspectRatio, duration, sound,
        }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error || `HTTP ${r.status}`); return; }
      const realBatchId = data.batch_id as string;
      const ctx: ActiveBatch = { batchId: realBatchId, prompt };
      setActive((prev) => [...prev, ctx]);
      const intervalId = setInterval(() => pollBatch(realBatchId, ctx), 6000);
      pollers.current.set(realBatchId, intervalId);
      pollBatch(realBatchId, ctx);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [startUrl, endUrl, prompt, model?.key, qualityLabel, aspectRatio, duration, sound, busy, pollBatch]);

  const handleCancel = useCallback(async (itemId: string) => {
    setItems((prev) => prev.filter((i) => i.item_id !== itemId));
    try { await fetch(`/api/item/${encodeURIComponent(itemId)}/cancel`, { method: "POST" }); } catch {}
  }, []);

  useEffect(() => {
    const cur = pollers.current;
    return () => { cur.forEach((id) => clearInterval(id)); cur.clear(); };
  }, []);

  const unitPrice = sound
    ? selectedQuality?.pricePerSecondWithAudio ?? 0
    : selectedQuality?.pricePerSecondNoAudio ?? 0;
  const estimatedCost = duration * unitPrice;
  const canGenerate = !!startUrl && !!prompt.trim() && !busy && !uploadingStart && !uploadingEnd;

  return (
    <div className="grid lg:grid-cols-[420px_1fr] gap-6 pb-32">
      <aside className="flex flex-col gap-4">
        {/* Frames */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[1.5px] text-pf-muted mb-2">
            Frames
          </div>
          <div className="grid grid-cols-2 gap-3">
            {/* Start frame */}
            <div>
              <div className="text-[10px] text-pf-muted mb-1.5">Start frame</div>
              {startUrl ? (
                <div className="relative aspect-square rounded-xl overflow-hidden border border-pf-border">
                  <img src={startUrl} alt="" className="w-full h-full object-cover" />
                  <button
                    type="button" onClick={() => setStartUrl(null)}
                    className="absolute top-1.5 right-1.5 bg-pf-bg/80 border border-pf-border rounded-md p-1 hover:bg-pf-danger hover:text-white"
                  ><X size={12} /></button>
                </div>
              ) : (
                <button
                  type="button" onClick={() => startInput.current?.click()} disabled={uploadingStart}
                  className="w-full aspect-square rounded-xl border border-dashed border-pf-border flex flex-col items-center justify-center text-pf-muted hover:border-pf-accent hover:text-pf-accent disabled:opacity-50"
                >
                  {uploadingStart ? <Loader2 size={20} className="animate-spin" /> : <ImagePlus size={20} />}
                  <span className="text-[10px] mt-1">Upload</span>
                </button>
              )}
              <input
                ref={startInput} type="file" accept="image/png,image/jpeg,image/webp"
                onChange={(e) => { handleStartFile(e.target.files); e.target.value = ""; }}
                className="hidden"
              />
            </div>

            {/* End frame (optional) */}
            <div>
              <div className="text-[10px] text-pf-muted mb-1.5">
                End frame <span className="text-pf-muted/60">(opt)</span>
              </div>
              {endUrl ? (
                <div className="relative aspect-square rounded-xl overflow-hidden border border-pf-border">
                  <img src={endUrl} alt="" className="w-full h-full object-cover" />
                  <button
                    type="button" onClick={() => setEndUrl(null)}
                    className="absolute top-1.5 right-1.5 bg-pf-bg/80 border border-pf-border rounded-md p-1 hover:bg-pf-danger hover:text-white"
                  ><X size={12} /></button>
                </div>
              ) : (
                <button
                  type="button" onClick={() => endInput.current?.click()} disabled={uploadingEnd}
                  className="w-full aspect-square rounded-xl border border-dashed border-pf-border flex flex-col items-center justify-center text-pf-muted hover:border-pf-accent hover:text-pf-accent disabled:opacity-50"
                >
                  {uploadingEnd ? <Loader2 size={20} className="animate-spin" /> : <ImagePlus size={20} />}
                  <span className="text-[10px] mt-1">Upload</span>
                </button>
              )}
              <input
                ref={endInput} type="file" accept="image/png,image/jpeg,image/webp"
                onChange={(e) => { handleEndFile(e.target.files); e.target.value = ""; }}
                className="hidden"
              />
            </div>
          </div>
        </div>

        {/* Prompt */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[1.5px] text-pf-muted mb-2">
            Prompt
          </div>
          <textarea
            value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5}
            placeholder="Describe the motion: camera moves, what happens between start and end frames..."
            className="w-full bg-pf-elev border border-pf-border rounded-xl p-3 text-sm text-pf-text placeholder:text-pf-muted resize-none outline-none focus:border-pf-accent"
          />
        </div>

        {/* Settings row */}
        <div className="bg-pf-elev border border-pf-border rounded-xl p-3">
          <div className="grid grid-cols-3 gap-2">
            {/* Aspect ratio */}
            <div className="relative">
              <button
                type="button" onClick={() => { setRatioOpen((s) => !s); setQualityOpen(false); setDurationOpen(false); }}
                className="w-full bg-pf-soft border border-pf-border rounded-lg p-2.5 hover:bg-pf-bg"
              >
                <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted">Ratio</div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <RatioIcon ratio={aspectRatio} size={14} />
                  <span className="font-semibold text-sm">{aspectRatio}</span>
                </div>
              </button>
              {ratioOpen && (
                <div className="absolute top-full mt-1 left-0 right-0 bg-pf-elev border border-pf-border rounded-lg shadow-2xl p-1 z-50">
                  {ratios.map((r) => (
                    <button
                      key={r} type="button"
                      onClick={() => { setAspectRatio(r); setRatioOpen(false); }}
                      className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-pf-soft ${r === aspectRatio ? "bg-pf-soft" : ""}`}
                    >
                      <RatioIcon ratio={r} size={14} />
                      <span className="text-sm flex-1 text-left">{r}</span>
                      {r === aspectRatio && <Check size={12} />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Duration */}
            <div className="relative">
              <button
                type="button" onClick={() => { setDurationOpen((s) => !s); setQualityOpen(false); setRatioOpen(false); }}
                className="w-full bg-pf-soft border border-pf-border rounded-lg p-2.5 hover:bg-pf-bg"
              >
                <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted">Duration</div>
                <div className="font-semibold text-sm mt-0.5">{duration}s</div>
              </button>
              {durationOpen && (
                <div className="absolute top-full mt-1 left-0 right-0 bg-pf-elev border border-pf-border rounded-lg shadow-2xl p-1 z-50 max-h-[240px] overflow-y-auto">
                  {durations.map((d) => (
                    <button
                      key={d} type="button"
                      onClick={() => { setDuration(d); setDurationOpen(false); }}
                      className={`block w-full text-left px-3 py-1.5 rounded-md hover:bg-pf-soft text-sm ${d === duration ? "text-pf-accent" : ""}`}
                    >{d}s</button>
                  ))}
                </div>
              )}
            </div>

            {/* Quality */}
            <div className="relative">
              <button
                type="button" onClick={() => { setQualityOpen((s) => !s); setRatioOpen(false); setDurationOpen(false); }}
                className="w-full bg-pf-soft border border-pf-border rounded-lg p-2.5 hover:bg-pf-bg"
              >
                <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted">Quality</div>
                <div className="font-semibold text-sm mt-0.5">{selectedQuality?.displayLabel}</div>
              </button>
              {qualityOpen && (
                <div className="absolute top-full mt-1 right-0 left-0 bg-pf-elev border border-pf-border rounded-lg shadow-2xl p-1 z-50 min-w-[200px]">
                  {qualities.map((q) => {
                    const price = sound ? q.pricePerSecondWithAudio : q.pricePerSecondNoAudio;
                    return (
                      <button
                        key={q.label} type="button"
                        onClick={() => { setQualityLabel(q.label); setQualityOpen(false); }}
                        className={`w-full text-left px-3 py-2 rounded-md hover:bg-pf-soft flex items-center justify-between ${q.label === qualityLabel ? "bg-pf-soft" : ""}`}
                      >
                        <div>
                          <div className="font-semibold text-sm">{q.displayLabel}</div>
                          <div className="text-[10px] text-pf-muted">
                            {q.resolution} · ${price.toFixed(3)}/s
                            {sound && q.pricePerSecondNoAudio !== q.pricePerSecondWithAudio && (
                              <span className="text-pf-muted/60"> (+audio)</span>
                            )}
                          </div>
                        </div>
                        {q.label === qualityLabel && <Check size={12} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Sound toggle + cost */}
          <div className="flex items-center justify-between mt-3 px-1">
            <button
              type="button" onClick={() => setSound((s) => !s)}
              className={`flex items-center gap-1.5 text-xs ${sound ? "text-pf-accent" : "text-pf-muted"}`}
            >
              {sound ? <Volume2 size={14} /> : <VolumeX size={14} />}
              <span>Sound {sound ? "on" : "off"}</span>
            </button>
            <div className="text-right">
              <div className="text-xs text-pf-muted">
                {duration}s × ${unitPrice.toFixed(3)}/s
              </div>
              <div className="font-semibold text-base">
                ${estimatedCost.toFixed(2)}
              </div>
            </div>
          </div>
        </div>

        <button
          type="button" onClick={handleGenerate} disabled={!canGenerate}
          className="w-full flex items-center justify-center gap-2 bg-pf-accent text-pf-accent-fg font-semibold rounded-lg py-3 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Sparkles size={16} />
          {busy ? "Submitting…" : "Generate"}
        </button>
        {!startUrl && <div className="text-[11px] text-pf-muted text-center">Upload a start frame to begin.</div>}
        {startUrl && !prompt.trim() && <div className="text-[11px] text-pf-muted text-center">Add a prompt.</div>}
        {error && <div className="text-[11px] text-pf-danger text-center">{error}</div>}
      </aside>

      <div>
        {active.length > 0 && (
          <div className="mb-4 inline-flex items-center gap-2 bg-pf-elev border border-pf-border rounded-full px-3 py-1 text-xs text-pf-dim">
            <span className="w-2 h-2 rounded-full bg-pf-accent animate-pulse" />
            <RefreshCcw size={11} className="animate-spin" />
            {active.length} video{active.length > 1 ? "s" : ""} rendering (3-15 min)
          </div>
        )}
        <Gallery items={items} onCancel={handleCancel} onOpen={setPreview} />
      </div>
      <ImagePreviewModal item={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
