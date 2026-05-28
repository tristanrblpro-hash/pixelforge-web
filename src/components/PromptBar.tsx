"use client";

import { useState } from "react";
import { Sparkles, Minus, Plus, ChevronDown } from "lucide-react";

type ImageModelInfo = {
  key: string;
  label: string;
  vendor: string;
  aspectRatios: string[];
  pricePerImage: number;
};

type Props = {
  models: ImageModelInfo[];
  busy?: boolean;
  onSubmit: (input: {
    prompt: string;
    modelKey: string;
    aspectRatio: string;
    count: number;
  }) => void;
};

export function PromptBar({ models, busy, onSubmit }: Props) {
  const [prompt, setPrompt] = useState("");
  const [modelKey, setModelKey] = useState(models[0]?.key ?? "");
  const [count, setCount] = useState(1);
  const [modelOpen, setModelOpen] = useState(false);
  const [ratioOpen, setRatioOpen] = useState(false);

  const selectedModel = models.find((m) => m.key === modelKey) || models[0];
  const ratios = selectedModel?.aspectRatios ?? ["1:1"];
  const [aspectRatio, setAspectRatio] = useState(ratios[0] ?? "1:1");

  const estimatedCost = (selectedModel?.pricePerImage ?? 0) * count;

  function handleGenerate() {
    if (!prompt.trim() || busy) return;
    onSubmit({ prompt: prompt.trim(), modelKey, aspectRatio, count });
  }

  return (
    <div className="fixed left-1/2 -translate-x-1/2 bottom-6 z-40 w-[min(960px,calc(100vw-48px))]">
      <div className="rounded-2xl border border-pf-border bg-pf-elev/95 backdrop-blur-md shadow-2xl">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              handleGenerate();
            }
          }}
          placeholder="Describe the image you want to generate…"
          rows={3}
          className="w-full bg-transparent text-pf-text placeholder:text-pf-muted resize-none border-0 outline-none p-5 pb-2 text-[15px] leading-relaxed"
        />

        <div className="flex items-center gap-2 px-4 pb-3 pt-1 flex-wrap">
          {/* Model selector */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { setModelOpen((s) => !s); setRatioOpen(false); }}
              className="flex items-center gap-2 bg-pf-soft border border-pf-border rounded-full px-3 py-1.5 text-sm hover:bg-pf-bg"
            >
              <span className="w-5 h-5 rounded-full bg-pf-accent text-pf-accent-fg flex items-center justify-center font-bold text-[10px]">
                G
              </span>
              <span>{selectedModel?.label ?? "Model"}</span>
              <ChevronDown size={14} className="text-pf-muted" />
            </button>
            {modelOpen && (
              <div className="absolute bottom-full mb-2 left-0 bg-pf-elev border border-pf-border rounded-lg shadow-2xl p-1 min-w-[240px] z-50">
                {models.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => {
                      setModelKey(m.key);
                      const first = m.aspectRatios[0] ?? "1:1";
                      if (!m.aspectRatios.includes(aspectRatio)) setAspectRatio(first);
                      setModelOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-md hover:bg-pf-soft ${
                      m.key === modelKey ? "text-pf-accent" : "text-pf-text"
                    }`}
                  >
                    <div className="font-semibold text-sm">{m.label}</div>
                    <div className="text-xs text-pf-muted">
                      {m.vendor} · ${m.pricePerImage.toFixed(3)}/img
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
              onClick={() => { setRatioOpen((s) => !s); setModelOpen(false); }}
              className="flex items-center gap-1.5 bg-pf-soft border border-pf-border rounded-full px-3 py-1.5 text-sm hover:bg-pf-bg"
            >
              <span className="text-pf-muted text-xs">▭</span>
              <span>{aspectRatio}</span>
              <ChevronDown size={14} className="text-pf-muted" />
            </button>
            {ratioOpen && (
              <div className="absolute bottom-full mb-2 left-0 bg-pf-elev border border-pf-border rounded-lg shadow-2xl p-1 z-50">
                {ratios.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => { setAspectRatio(r); setRatioOpen(false); }}
                    className={`block w-full text-left px-3 py-1.5 rounded-md hover:bg-pf-soft text-sm ${
                      r === aspectRatio ? "text-pf-accent" : "text-pf-text"
                    }`}
                  >
                    {r}
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
            est. ${estimatedCost.toFixed(3)}
          </span>

          <button
            type="button"
            onClick={handleGenerate}
            disabled={!prompt.trim() || busy}
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
