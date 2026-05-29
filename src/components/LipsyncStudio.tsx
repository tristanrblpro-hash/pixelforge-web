"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Sparkles, Loader2, ImagePlus, Music, X, Play, Pause, RefreshCcw, ChevronDown, Check,
} from "lucide-react";
import { Gallery, type GalleryItem } from "./Gallery";
import { ImagePreviewModal } from "./ImagePreviewModal";

type LipsyncQualityInfo = {
  label: string;
  resolution: string;
  fps: number;
  pricePerSecond: number;
};

type LipsyncModelInfo = {
  key: string;
  label: string;
  vendor: string;
  maxAudioSeconds: number;
  qualities: LipsyncQualityInfo[];
};

type Props = {
  models: LipsyncModelInfo[];
  initialItems: GalleryItem[];
};

type ActiveBatch = {
  batchId: string;
  prompt: string;
  modelKey: string;
};

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

const LS_KEY = "pixelforge_lipsync_inputs_v1";

type PersistedInputs = {
  imageUrl?: string | null;
  audioUrl?: string | null;
  audioName?: string | null;
  audioDuration?: number;
  prompt?: string;
  qualityLabel?: string;
};

function loadPersisted(): PersistedInputs {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as PersistedInputs) : {};
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

export function LipsyncStudio({ models, initialItems }: Props) {
  const selectedModel = models[0];
  const qualities = selectedModel?.qualities ?? [];

  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioName, setAudioName] = useState<string | null>(null);
  const [audioDuration, setAudioDuration] = useState<number>(0);
  const [prompt, setPrompt] = useState("");
  const [qualityLabel, setQualityLabel] = useState<string>(qualities[0]?.label ?? "Pro");
  const [qualityOpen, setQualityOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const selectedQuality = qualities.find((q) => q.label === qualityLabel) ?? qualities[0];

  // Rehydrate from localStorage on first mount.
  useEffect(() => {
    const p = loadPersisted();
    if (p.imageUrl) {
      setImageUrl(p.imageUrl);
      // Use the public Supabase URL as preview source; no need to recreate ObjectURL.
      setImagePreview(p.imageUrl);
    }
    if (p.audioUrl) setAudioUrl(p.audioUrl);
    if (p.audioName) setAudioName(p.audioName);
    if (p.audioDuration) setAudioDuration(p.audioDuration);
    if (p.prompt) setPrompt(p.prompt);
    if (p.qualityLabel && qualities.some((q) => q.label === p.qualityLabel)) {
      setQualityLabel(p.qualityLabel);
    }
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on every meaningful change (after hydration to avoid clobbering).
  useEffect(() => {
    if (!hydrated) return;
    savePersisted({ imageUrl, audioUrl, audioName, audioDuration, prompt, qualityLabel });
  }, [hydrated, imageUrl, audioUrl, audioName, audioDuration, prompt, qualityLabel]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<GalleryItem[]>(initialItems);
  const [active, setActive] = useState<ActiveBatch[]>([]);
  const [preview, setPreview] = useState<GalleryItem | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);

  const imageInput = useRef<HTMLInputElement | null>(null);
  const audioInput = useRef<HTMLInputElement | null>(null);
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const pollers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  const overLimit = audioDuration > (selectedModel?.maxAudioSeconds ?? 300);

  async function uploadFile(file: File, target: "image" | "audio") {
    setError(null);
    const form = new FormData();
    form.append("file", file);
    const r = await fetch("/api/upload", { method: "POST", body: form });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data.url as string;
  }

  async function handleImageFiles(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) { setError("Please pick an image file."); return; }
    setUploadingImage(true);
    const local = URL.createObjectURL(f);
    setImagePreview((prev) => { if (prev) URL.revokeObjectURL(prev); return local; });
    try {
      const url = await uploadFile(f, "image");
      setImageUrl(url);
    } catch (e) {
      setError(String(e));
      setImagePreview(null);
    } finally {
      setUploadingImage(false);
    }
  }

  async function handleAudioFiles(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    if (!/^audio\//.test(f.type)) { setError("Please pick an audio file."); return; }
    setUploadingAudio(true);
    setAudioName(f.name);
    // Probe duration locally
    const probe = new Audio(URL.createObjectURL(f));
    probe.onloadedmetadata = () => setAudioDuration(probe.duration || 0);
    try {
      const url = await uploadFile(f, "audio");
      setAudioUrl(url);
    } catch (e) {
      setError(String(e));
      setAudioName(null);
      setAudioDuration(0);
    } finally {
      setUploadingAudio(false);
    }
  }

  function removeImage() {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageUrl(null);
    setImagePreview(null);
  }
  function removeAudio() {
    setAudioUrl(null);
    setAudioName(null);
    setAudioDuration(0);
    setAudioPlaying(false);
    if (audioEl.current) audioEl.current.pause();
  }

  function toggleAudio() {
    if (!audioEl.current) return;
    if (audioPlaying) audioEl.current.pause();
    else audioEl.current.play();
  }

  const stopPolling = useCallback((batchId: string) => {
    const id = pollers.current.get(batchId);
    if (id) {
      clearInterval(id);
      pollers.current.delete(batchId);
    }
    setActive((prev) => prev.filter((b) => b.batchId !== batchId));
  }, []);

  const pollBatch = useCallback(async (batchId: string, ctx: ActiveBatch) => {
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
            aspect_ratio: existing?.aspect_ratio ?? "9:16",
            model_key: existing?.model_key ?? ctx.modelKey,
          };
          map.set(ri.item_id, merged);
        }
        return Array.from(map.values()).sort((a, b) =>
          (b.batch_id || "").localeCompare(a.batch_id || ""),
        );
      });

      const allTerminal = remoteItems.every((i) => i.status === "done" || i.status === "failed");
      if (allTerminal && remoteItems.length > 0) stopPolling(batchId);
    } catch {}
  }, [stopPolling]);

  const handleGenerate = useCallback(async () => {
    if (!imageUrl || !audioUrl || busy || overLimit) return;
    setBusy(true);
    setError(null);

    const tempId = `tmp_${Date.now().toString(36)}`;
    const placeholder: GalleryItem = {
      item_id: tempId,
      batch_id: tempId,
      idx: 0,
      status: "queued",
      prompt,
      aspect_ratio: "9:16",
      model_key: selectedModel?.key,
    };
    setItems((prev) => [placeholder, ...prev]);

    try {
      const r = await fetch("/api/lipsync/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl,
          audioUrl,
          prompt,
          modelKey: selectedModel?.key,
          qualityLabel,
          audioDurationSec: audioDuration,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        setItems((prev) => prev.filter((it) => it.item_id !== tempId));
        return;
      }
      const realBatchId = data.batch_id as string;
      const ctx: ActiveBatch = { batchId: realBatchId, prompt, modelKey: selectedModel?.key ?? "" };
      setActive((prev) => [...prev, ctx]);
      setItems((prev) => prev.filter((it) => it.item_id !== tempId));
      const intervalId = setInterval(() => pollBatch(realBatchId, ctx), 6000);
      pollers.current.set(realBatchId, intervalId);
      pollBatch(realBatchId, ctx);
    } catch (e) {
      setError(String(e));
      setItems((prev) => prev.filter((it) => it.item_id !== tempId));
    } finally {
      setBusy(false);
    }
  }, [imageUrl, audioUrl, prompt, busy, overLimit, audioDuration, selectedModel, pollBatch]);

  const handleCancel = useCallback(async (itemId: string) => {
    setItems((prev) => prev.filter((i) => i.item_id !== itemId));
    try {
      await fetch(`/api/item/${encodeURIComponent(itemId)}/cancel`, { method: "POST" });
    } catch {}
  }, []);

  useEffect(() => {
    const cur = pollers.current;
    return () => { cur.forEach((id) => clearInterval(id)); cur.clear(); };
  }, []);

  const canGenerate = !!imageUrl && !!audioUrl && !busy && !uploadingImage && !uploadingAudio && !overLimit;

  return (
    <div className="grid lg:grid-cols-[420px_1fr] gap-6 pb-32">
      {/* LEFT — controls */}
      <aside className="flex flex-col gap-4">
        {/* Image */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[1.5px] text-pf-muted mb-2">
            Avatar image
          </div>
          {imagePreview ? (
            <div className="relative rounded-xl overflow-hidden border border-pf-border aspect-square max-w-[260px]">
              <img src={imagePreview} alt="" className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={removeImage}
                className="absolute top-2 right-2 bg-pf-bg/80 border border-pf-border rounded-md p-1 hover:bg-pf-danger hover:text-white"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => imageInput.current?.click()}
              disabled={uploadingImage}
              className="w-full max-w-[260px] aspect-square rounded-xl border border-dashed border-pf-border flex flex-col items-center justify-center text-pf-muted hover:border-pf-accent hover:text-pf-accent disabled:opacity-50"
            >
              {uploadingImage ? <Loader2 size={28} className="animate-spin" /> : <ImagePlus size={28} />}
              <span className="text-xs mt-2">Upload image (PNG/JPG)</span>
              <span className="text-[10px] text-pf-muted mt-0.5">max 50 MB</span>
            </button>
          )}
          <input
            ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp"
            onChange={(e) => { handleImageFiles(e.target.files); e.target.value = ""; }}
            className="hidden"
          />
        </div>

        {/* Audio */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[1.5px] text-pf-muted mb-2">
            Audio voiceover
          </div>
          {audioUrl ? (
            <div className="border border-pf-border rounded-xl p-3 flex items-center gap-3 bg-pf-elev">
              <button
                type="button"
                onClick={toggleAudio}
                className="w-10 h-10 rounded-full bg-pf-soft border border-pf-border flex items-center justify-center hover:bg-pf-bg"
              >
                {audioPlaying ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{audioName}</div>
                <div className="text-[11px] text-pf-muted">
                  {formatDuration(audioDuration)} {overLimit && (
                    <span className="text-pf-danger ml-1">· exceeds 5 min limit</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={removeAudio}
                className="p-1.5 rounded-md hover:bg-pf-danger hover:text-white"
              >
                <X size={14} />
              </button>
              <audio
                ref={audioEl} src={audioUrl}
                onPlay={() => setAudioPlaying(true)}
                onPause={() => setAudioPlaying(false)}
                onEnded={() => setAudioPlaying(false)}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => audioInput.current?.click()}
              disabled={uploadingAudio}
              className="w-full rounded-xl border border-dashed border-pf-border py-6 flex flex-col items-center justify-center text-pf-muted hover:border-pf-accent hover:text-pf-accent disabled:opacity-50"
            >
              {uploadingAudio ? <Loader2 size={24} className="animate-spin" /> : <Music size={24} />}
              <span className="text-xs mt-2">Upload audio (MP3/WAV/AAC/OGG)</span>
              <span className="text-[10px] text-pf-muted mt-0.5">max 5 min · 50 MB</span>
            </button>
          )}
          <input
            ref={audioInput} type="file"
            accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/aac,audio/mp4,audio/ogg"
            onChange={(e) => { handleAudioFiles(e.target.files); e.target.value = ""; }}
            className="hidden"
          />
        </div>

        {/* Prompt */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[1.5px] text-pf-muted mb-2">
            Direction prompt
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="Locked gaze: he maintains direct eye contact with the camera for the entire clip, never glancing to the side. The video plan must not move; it must remain fixed."
            className="w-full bg-pf-elev border border-pf-border rounded-xl p-3 text-sm text-pf-text placeholder:text-pf-muted resize-none outline-none focus:border-pf-accent"
          />
        </div>

        {/* Model + Quality + Generate */}
        <div className="bg-pf-elev border border-pf-border rounded-xl p-3 mt-2">
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div className="bg-pf-soft border border-pf-border rounded-lg p-2.5">
              <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted">Model</div>
              <div className="font-semibold text-sm mt-0.5 truncate">{selectedModel?.label}</div>
            </div>

            {/* Quality dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setQualityOpen((s) => !s)}
                className="w-full bg-pf-soft border border-pf-border rounded-lg p-2.5 text-left hover:bg-pf-bg"
              >
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted">Quality</div>
                    <div className="font-semibold text-sm mt-0.5">{selectedQuality?.label}</div>
                    <div className="text-[10px] text-pf-muted">
                      {selectedQuality?.resolution}, {selectedQuality?.fps}fps
                    </div>
                  </div>
                  <ChevronDown size={14} className="text-pf-muted mt-1 shrink-0" />
                </div>
              </button>
              {qualityOpen && (
                <div className="absolute top-full mt-1 right-0 left-0 bg-pf-elev border border-pf-border rounded-lg shadow-2xl p-1 z-50">
                  {qualities.map((q) => {
                    const selected = q.label === qualityLabel;
                    return (
                      <button
                        key={q.label}
                        type="button"
                        onClick={() => { setQualityLabel(q.label); setQualityOpen(false); }}
                        className={`w-full text-left px-3 py-2 rounded-md hover:bg-pf-soft flex items-center justify-between ${
                          selected ? "bg-pf-soft" : ""
                        }`}
                      >
                        <div>
                          <div className="font-semibold text-sm">{q.label}</div>
                          <div className="text-[10px] text-pf-muted">
                            {q.resolution}, {q.fps}fps · ${q.pricePerSecond.toFixed(2)}/s
                          </div>
                        </div>
                        {selected && <Check size={14} className="text-pf-text" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {audioDuration > 0 && (
            <div className="flex items-center justify-between text-xs mb-3 px-1">
              <span className="text-pf-muted">
                Est. cost · {formatDuration(audioDuration)} × ${selectedQuality?.pricePerSecond.toFixed(2)}/s
              </span>
              <span className="font-semibold text-base text-pf-text">
                ${(audioDuration * (selectedQuality?.pricePerSecond ?? 0)).toFixed(2)}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!canGenerate}
            className="w-full flex items-center justify-center gap-2 bg-pf-accent text-pf-accent-fg font-semibold rounded-lg py-2.5 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Sparkles size={16} />
            {busy ? "Submitting…" : "Generate"}
          </button>
          {!imageUrl && <div className="text-[11px] text-pf-muted mt-2 text-center">Upload an image to start.</div>}
          {imageUrl && !audioUrl && <div className="text-[11px] text-pf-muted mt-2 text-center">Add an audio file.</div>}
          {error && <div className="text-[11px] text-pf-danger mt-2 text-center">{error}</div>}
        </div>
      </aside>

      {/* RIGHT — gallery */}
      <div>
        {active.length > 0 && (
          <div className="mb-4 inline-flex items-center gap-2 bg-pf-elev border border-pf-border rounded-full px-3 py-1 text-xs text-pf-dim">
            <span className="w-2 h-2 rounded-full bg-pf-accent animate-pulse" />
            <RefreshCcw size={11} className="animate-spin" />
            {active.length} lipsync running (5–15 min)
          </div>
        )}
        <Gallery items={items} onCancel={handleCancel} onOpen={setPreview} />
      </div>

      <ImagePreviewModal item={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
