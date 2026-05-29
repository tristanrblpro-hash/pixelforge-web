"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, Minus, Plus, ChevronDown, Check, ImagePlus, X, Loader2 } from "lucide-react";
import { RatioIcon } from "./RatioIcon";

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
  busy?: boolean;
  onSubmit: (input: {
    prompt: string;
    modelKey: string;
    aspectRatio: string;
    quality: string;
    count: number;
    inputUrls: string[];
  }) => void;
  // Prefill the prompt textarea (used by the "Send to Nano Banana" handoff
  // from /prompts). Changes to this prop overwrite the current prompt.
  initialPrompt?: string;
  // Pre-select a model (e.g. force "nano-banana-pro" when arriving from the
  // Prompts page).
  initialModelKey?: string;
  // When this token changes (e.g. a new timestamp), the bar auto-submits
  // once with the current values. Used for the handoff "auto-run" path.
  autoSubmitToken?: string | null;
};

type RefImage = { url: string; localPreview?: string };

// localStorage slot for the bar itself — so the user's in-progress prompt,
// reference images, model + ratio + quality + count survive a page refresh
// or a navigation away and back.
//
// NB: refs only carry the public Supabase URL across reloads (localPreview
// blob: URLs are tab-scoped and die on refresh); the UI falls back to the
// remote URL just fine.
const BAR_STORAGE_KEY = "pf:promptBar:v1";

type PersistedBar = {
  prompt: string;
  modelKey: string;
  aspectRatio: string;
  quality: string;
  count: number;
  refs: Array<{ url: string }>;
};

function readPersisted(): Partial<PersistedBar> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(BAR_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedBar>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function Badge({ kind }: { kind: "TOP" | "NEW" | "SOON" }) {
  const styles: Record<typeof kind, string> = {
    NEW: "bg-pf-accent text-pf-accent-fg",
    TOP: "bg-pink-500 text-white",
    SOON: "bg-pf-soft text-pf-muted",
  };
  return (
    <span className={`text-[9px] font-bold uppercase tracking-wider rounded px-1.5 py-0.5 ${styles[kind]}`}>
      {kind}
    </span>
  );
}

export function PromptBar({
  models,
  busy,
  onSubmit,
  initialPrompt,
  initialModelKey,
  autoSubmitToken,
}: Props) {
  // Hydrate from localStorage synchronously on first render so the bar is
  // never empty for a frame. Handoff props (initialPrompt / initialModelKey)
  // always win over persisted state.
  const persisted = typeof window !== "undefined" ? readPersisted() : {};

  const [prompt, setPrompt] = useState(initialPrompt ?? persisted.prompt ?? "");
  const [modelKey, setModelKey] = useState(() => {
    if (initialModelKey && models.some((m) => m.key === initialModelKey)) return initialModelKey;
    if (persisted.modelKey && models.some((m) => m.key === persisted.modelKey)) {
      return persisted.modelKey;
    }
    return models[0]?.key ?? "";
  });
  const [count, setCount] = useState(
    typeof persisted.count === "number" && persisted.count >= 1 && persisted.count <= 20
      ? persisted.count
      : 1,
  );
  const [modelOpen, setModelOpen] = useState(false);
  const [ratioOpen, setRatioOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);

  const selectedModel = models.find((m) => m.key === modelKey) || models[0];
  const ratios = selectedModel?.aspectRatios ?? ["1:1"];
  const qualities = selectedModel?.qualities ?? ["1K"];
  const maxRefs = selectedModel?.maxInputImages ?? 0;

  const initialRatio =
    persisted.aspectRatio && ratios.includes(persisted.aspectRatio)
      ? persisted.aspectRatio
      : ratios.includes("9:16")
        ? "9:16"
        : ratios[0] ?? "1:1";
  const initialQuality =
    persisted.quality && qualities.includes(persisted.quality)
      ? persisted.quality
      : qualities.includes("1K")
        ? "1K"
        : qualities[0] ?? "1K";
  const [aspectRatio, setAspectRatio] = useState(initialRatio);
  const [quality, setQuality] = useState(initialQuality);

  const [refs, setRefs] = useState<RefImage[]>(() => {
    const arr = Array.isArray(persisted.refs) ? persisted.refs : [];
    return arr
      .filter((r) => r && typeof r.url === "string" && r.url.startsWith("http"))
      .map((r) => ({ url: r.url }));
  });
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Persist on every change of the watched fields.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const payload: PersistedBar = {
        prompt,
        modelKey,
        aspectRatio,
        quality,
        count,
        refs: refs.map((r) => ({ url: r.url })),
      };
      window.localStorage.setItem(BAR_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* quota / private mode — non-fatal */
    }
  }, [prompt, modelKey, aspectRatio, quality, count, refs]);

  // Snap aspect/quality to a valid value when the model changes.
  useEffect(() => {
    if (!ratios.includes(aspectRatio)) {
      setAspectRatio(ratios.includes("9:16") ? "9:16" : ratios[0] ?? "1:1");
    }
    if (!qualities.includes(quality)) {
      setQuality(qualities.includes("1K") ? "1K" : qualities[0] ?? "1K");
    }
    // Trim refs if the new model accepts fewer.
    if (refs.length > maxRefs) {
      setRefs((r) => r.slice(0, maxRefs));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey]);

  // Receive an external prompt prefill (e.g. handoff from /prompts).
  useEffect(() => {
    if (typeof initialPrompt === "string" && initialPrompt.length > 0) {
      setPrompt(initialPrompt);
    }
  }, [initialPrompt]);
  useEffect(() => {
    if (initialModelKey && models.some((m) => m.key === initialModelKey)) {
      setModelKey(initialModelKey);
    }
  }, [initialModelKey, models]);

  // Auto-submit when the parent bumps the token (one-shot trigger).
  const lastAutoToken = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSubmitToken) return;
    if (lastAutoToken.current === autoSubmitToken) return;
    if (!prompt.trim() || busy || uploading) return;
    lastAutoToken.current = autoSubmitToken;
    // Defer one tick so the prompt state is committed before submitting.
    const t = setTimeout(() => {
      closeAllMenus();
      onSubmit({
        prompt: prompt.trim(),
        modelKey,
        aspectRatio,
        quality,
        count,
        inputUrls: refs.map((r) => r.url),
      });
    }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSubmitToken, prompt]);

  const unitPrice =
    selectedModel?.pricing?.[quality] ?? selectedModel?.defaultPricePerImage ?? 0;
  const estimatedCost = unitPrice * count;
  const pricePrefix = selectedModel?.pricingNote ? "~" : "";

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (maxRefs === 0) {
      setUploadError(`${selectedModel?.label} doesn't accept reference images.`);
      return;
    }
    setUploadError(null);
    const slots = maxRefs - refs.length;
    const toUpload = Array.from(files).slice(0, slots);
    setUploading(true);
    for (const f of toUpload) {
      const localPreview = URL.createObjectURL(f);
      try {
        const form = new FormData();
        form.append("file", f);
        const r = await fetch("/api/upload", { method: "POST", body: form });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        setRefs((prev) => [...prev, { url: data.url, localPreview }]);
      } catch (e) {
        setUploadError(String(e));
      }
    }
    setUploading(false);
  }

  function removeRef(idx: number) {
    setRefs((prev) => {
      const next = [...prev];
      const removed = next.splice(idx, 1)[0];
      if (removed?.localPreview) URL.revokeObjectURL(removed.localPreview);
      return next;
    });
  }

  function closeAllMenus() {
    setModelOpen(false);
    setRatioOpen(false);
    setQualityOpen(false);
  }

  function handleGenerate() {
    if (!prompt.trim() || busy || uploading) return;
    closeAllMenus();
    onSubmit({
      prompt: prompt.trim(),
      modelKey,
      aspectRatio,
      quality,
      count,
      inputUrls: refs.map((r) => r.url),
    });
  }

  const canAddMore = refs.length < maxRefs;

  return (
    <div className="fixed left-1/2 -translate-x-1/2 bottom-6 z-40 w-[min(960px,calc(100vw-48px))]">
      <div className="rounded-2xl border border-pf-border bg-pf-elev/95 backdrop-blur-md shadow-2xl">
        {/* Reference images row */}
        {(refs.length > 0 || maxRefs > 0) && (
          <div className="flex gap-2 items-center px-4 pt-4 pb-1 flex-wrap">
            {refs.map((r, i) => (
              <div
                key={i}
                className="relative w-16 h-16 rounded-lg overflow-hidden border border-pf-border group/ref"
              >
                <img src={r.localPreview ?? r.url} alt="" className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={() => removeRef(i)}
                  className="absolute top-0.5 right-0.5 bg-pf-bg/80 border border-pf-border rounded p-0.5 opacity-0 group-hover/ref:opacity-100 transition-opacity hover:bg-pf-danger hover:text-white"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
            {canAddMore && (
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={uploading}
                className="w-16 h-16 rounded-lg border border-dashed border-pf-border flex flex-col items-center justify-center text-pf-muted hover:border-pf-accent hover:text-pf-accent disabled:opacity-50"
              >
                {uploading ? <Loader2 size={18} className="animate-spin" /> : <ImagePlus size={18} />}
                <span className="text-[9px] mt-0.5">{refs.length}/{maxRefs}</span>
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(e) => {
                handleFiles(e.target.files);
                e.target.value = "";
              }}
              className="hidden"
            />
            {uploadError && (
              <span className="text-xs text-pf-danger ml-1">{uploadError}</span>
            )}
          </div>
        )}

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              handleGenerate();
            }
          }}
          placeholder={refs.length > 0 ? "Describe the scene you imagine…" : "Describe the image you want to generate…"}
          rows={3}
          className="w-full bg-transparent text-pf-text placeholder:text-pf-muted resize-none border-0 outline-none p-5 pb-2 text-[15px] leading-relaxed"
        />

        <div className="flex items-center gap-2 px-4 pb-3 pt-1 flex-wrap">
          {/* Model selector */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { setModelOpen((s) => !s); setRatioOpen(false); setQualityOpen(false); }}
              className="flex items-center gap-2 bg-pf-soft border border-pf-border rounded-full px-3 py-1.5 text-sm hover:bg-pf-bg"
            >
              <span className="w-5 h-5 rounded-full bg-pf-accent text-pf-accent-fg flex items-center justify-center font-bold text-[10px]">
                G
              </span>
              <span>{selectedModel?.label ?? "Model"}</span>
              <ChevronDown size={14} className="text-pf-muted" />
            </button>
            {modelOpen && (
              <div className="absolute bottom-full mb-2 left-0 bg-pf-elev border border-pf-border rounded-lg shadow-2xl p-1 min-w-[280px] z-50">
                {models.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => {
                      setModelKey(m.key);
                      setModelOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-md hover:bg-pf-soft flex items-start gap-2 ${
                      m.key === modelKey ? "text-pf-accent" : "text-pf-text"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">{m.label}</span>
                        {m.badge && <Badge kind={m.badge} />}
                      </div>
                      <div className="text-xs text-pf-muted mt-0.5">
                        {m.vendor} · {m.pricingNote ? "~" : ""}from $
                        {(m.pricing[m.qualities[0]] ?? m.defaultPricePerImage).toFixed(3)}/img
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Aspect ratio */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { setRatioOpen((s) => !s); setModelOpen(false); setQualityOpen(false); }}
              className="flex items-center gap-1.5 bg-pf-soft border border-pf-border rounded-full px-3 py-1.5 text-sm hover:bg-pf-bg"
            >
              <span className="text-pf-text">
                <RatioIcon ratio={aspectRatio} size={14} />
              </span>
              <span>{aspectRatio}</span>
              <ChevronDown size={14} className="text-pf-muted" />
            </button>
            {ratioOpen && (
              <div className="absolute bottom-full mb-2 left-0 bg-pf-elev border border-pf-border rounded-xl shadow-2xl p-1.5 z-50 min-w-[180px] max-h-[400px] overflow-y-auto">
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[1.2px] text-pf-muted">
                  Aspect ratio
                </div>
                {ratios.map((r) => {
                  const selected = r === aspectRatio;
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() => { setAspectRatio(r); setRatioOpen(false); }}
                      className={`flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm hover:bg-pf-soft ${
                        selected ? "bg-pf-soft" : ""
                      }`}
                    >
                      <span className={selected ? "text-pf-text" : "text-pf-dim"}>
                        <RatioIcon ratio={r} />
                      </span>
                      <span className={`flex-1 text-left ${selected ? "text-pf-text" : "text-pf-dim"}`}>
                        {r === "auto" ? "Auto" : r}
                      </span>
                      {selected && <Check size={14} className="text-pf-text" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Quality */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { setQualityOpen((s) => !s); setModelOpen(false); setRatioOpen(false); }}
              className="flex items-center gap-1.5 bg-pf-soft border border-pf-border rounded-full px-3 py-1.5 text-sm hover:bg-pf-bg"
            >
              <span className="text-pf-muted text-xs">✦</span>
              <span>{quality}</span>
              <ChevronDown size={14} className="text-pf-muted" />
            </button>
            {qualityOpen && (
              <div className="absolute bottom-full mb-2 left-0 bg-pf-elev border border-pf-border rounded-lg shadow-2xl p-1 z-50 min-w-[80px]">
                {qualities.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => { setQuality(q); setQualityOpen(false); }}
                    className={`block w-full text-left px-3 py-1.5 rounded-md hover:bg-pf-soft text-sm ${
                      q === quality ? "text-pf-accent" : "text-pf-text"
                    }`}
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Counter */}
          <div className="flex items-center gap-2 bg-pf-soft border border-pf-border rounded-full px-2 py-1 text-sm">
            <button
              type="button"
              onClick={() => setCount((c) => Math.max(1, c - 1))}
              className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-pf-bg"
            >
              <Minus size={14} />
            </button>
            <span className="min-w-[36px] text-center text-sm">{count} / 20</span>
            <button
              type="button"
              onClick={() => setCount((c) => Math.min(20, c + 1))}
              className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-pf-bg"
            >
              <Plus size={14} />
            </button>
          </div>

          <div className="flex-1" />

          <span className="text-xs text-pf-muted hidden sm:block">
            est. {pricePrefix}${estimatedCost.toFixed(3)}
          </span>

          <button
            type="button"
            onClick={handleGenerate}
            disabled={!prompt.trim() || busy || uploading}
            className="flex items-center gap-2 bg-pf-accent text-pf-accent-fg font-semibold rounded-full px-5 py-2 text-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            <Sparkles size={16} />
            {busy ? "Generating…" : "Generate"}
            <span className="bg-black/15 rounded-full px-1.5 text-xs">{count}</span>
          </button>
        </div>
      </div>
      <div className="text-center text-[11px] text-pf-muted mt-2">
        ⌘ + Enter to generate · KIE.ai bills your account per image
      </div>
    </div>
  );
}
