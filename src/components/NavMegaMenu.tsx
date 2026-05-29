"use client";

import Link from "next/link";
import {
  ImagePlus,
  Layers,
  Wand2,
  Languages,
  Mic,
  ArrowUpToLine,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type ToolItem = {
  label: string;
  href: string;
  description: string;
  icon: LucideIcon;
  comingSoon?: boolean;
};

type ModelItem = {
  label: string;
  badge?: "NEW" | "TOP" | "SOON";
  description: string;
  vendor: string;
  letter: string; // monogram icon
  available: boolean;
};

const IMAGE_TOOLS: ToolItem[] = [
  {
    label: "Image generation",
    href: "/",
    description: "Text-to-image with up to 20 generations in parallel.",
    icon: ImagePlus,
  },
  {
    label: "Batch image edit",
    href: "/batch-edit",
    description: "Upload N images + 1 prompt, edit them all in parallel.",
    icon: Layers,
    comingSoon: true,
  },
  {
    label: "Upscale (Topaz)",
    href: "/upscale",
    description: "2×, 4× or 8× image enhancement.",
    icon: ArrowUpToLine,
    comingSoon: true,
  },
  {
    label: "Translate page",
    href: "/translate",
    description: "Scrape a URL, translate or brand-swap its images.",
    icon: Languages,
    comingSoon: true,
  },
  {
    label: "Avatar (talking head)",
    href: "/avatar",
    description: "Image + audio → lip-synced video.",
    icon: Mic,
    comingSoon: true,
  },
];

const IMAGE_MODELS: ModelItem[] = [
  {
    label: "Nano Banana Pro",
    badge: "TOP",
    description: "Best 4K image model. Strong in-image text, brand fidelity.",
    vendor: "Google",
    letter: "G",
    available: true,
  },
  {
    label: "GPT Image 2",
    badge: "NEW",
    description: "4K images with near-perfect text rendering. T2I + I2I.",
    vendor: "OpenAI",
    letter: "O",
    available: true,
  },
  {
    label: "Wan 2.7 Pro",
    badge: "NEW",
    description: "Strong editing, supports panoramic 8:1 and 1:8.",
    vendor: "Alibaba",
    letter: "W",
    available: true,
  },
  {
    label: "Seedream 4.5",
    description: "Photorealistic with intelligent visual reasoning.",
    vendor: "ByteDance",
    letter: "S",
    available: true,
  },
  {
    label: "Nano Banana",
    description: "Fast + cheap variant of Nano Banana Pro.",
    vendor: "Google",
    letter: "G",
    available: true,
  },
  {
    label: "Flux Pro 1.1",
    badge: "SOON",
    description: "Photorealistic, fast.",
    vendor: "Black Forest Labs",
    letter: "F",
    available: false,
  },
  {
    label: "Ideogram v3",
    badge: "SOON",
    description: "Strong typography & poster layouts.",
    vendor: "Ideogram",
    letter: "I",
    available: false,
  },
];

function Badge({ kind }: { kind: "NEW" | "TOP" | "SOON" }) {
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

export function ImageMegaMenu({ onClose }: { onClose?: () => void }) {
  return (
    <div
      className="bg-pf-elev border border-pf-border rounded-xl shadow-2xl p-6 grid grid-cols-2 gap-x-8 w-[760px] max-w-[calc(100vw-32px)]"
    >
      {/* Tools */}
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[1.5px] text-pf-muted mb-4">
          Tools
        </div>
        <div className="flex flex-col gap-1">
          {IMAGE_TOOLS.map((t) => {
            const Icon = t.icon;
            return (
              <Link
                key={t.href}
                href={t.href}
                onClick={onClose}
                className={`flex items-start gap-3 px-3 py-2.5 rounded-lg group transition-colors ${
                  t.comingSoon ? "opacity-50" : "hover:bg-pf-soft"
                }`}
              >
                <div className="mt-0.5 w-9 h-9 rounded-md bg-pf-soft border border-pf-border flex items-center justify-center text-pf-text group-hover:border-pf-accent group-hover:text-pf-accent">
                  <Icon size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-pf-text flex items-center gap-2">
                    {t.label}
                    {t.comingSoon && <span className="text-[9px] text-pf-muted font-bold uppercase">Soon</span>}
                  </div>
                  <div className="text-xs text-pf-muted leading-snug mt-0.5 line-clamp-2">
                    {t.description}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Models */}
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[1.5px] text-pf-muted mb-4">
          Models
        </div>
        <div className="flex flex-col gap-1 max-h-[400px] overflow-y-auto pr-1">
          {IMAGE_MODELS.map((m, i) => (
            <div
              key={i}
              className={`flex items-start gap-3 px-3 py-2.5 rounded-lg ${
                m.available ? "hover:bg-pf-soft cursor-pointer" : "opacity-50"
              }`}
            >
              <div className="relative mt-0.5">
                <div className="w-9 h-9 rounded-md bg-pf-soft border border-pf-border flex items-center justify-center font-bold text-pf-text">
                  {m.letter}
                </div>
                {m.badge && (
                  <div className="absolute -top-1.5 -left-1.5">
                    <Badge kind={m.badge} />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-pf-text flex items-center gap-2">
                  {m.label}
                </div>
                <div className="text-xs text-pf-muted leading-snug mt-0.5 line-clamp-2">
                  {m.description}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function VideoMegaMenu({ onClose }: { onClose?: () => void }) {
  const videoModels: ModelItem[] = [
    { label: "Kling Avatars 2.0", badge: "TOP",  description: "Talking-head lipsync, up to 5 min audio.", vendor: "Kling",     letter: "K", available: true },
    { label: "Kling 2.1 Master",  badge: "SOON", description: "Best motion quality.",                     vendor: "Kling",     letter: "K", available: false },
    { label: "Sora 2",            badge: "SOON", description: "OpenAI cinematic.",                        vendor: "OpenAI",    letter: "O", available: false },
    { label: "Veo 3",             badge: "SOON", description: "Google realistic w/ audio.",               vendor: "Google",    letter: "G", available: false },
    { label: "Seedance V1 Pro",   badge: "SOON", description: "ByteDance budget t2v / i2v.",              vendor: "ByteDance", letter: "S", available: false },
  ];

  return (
    <div className="bg-pf-elev border border-pf-border rounded-xl shadow-2xl p-6 grid grid-cols-2 gap-x-8 w-[760px] max-w-[calc(100vw-32px)]">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[1.5px] text-pf-muted mb-4">
          Tools
        </div>
        <Link
          href="/video"
          onClick={onClose}
          className="flex items-start gap-3 px-3 py-2.5 rounded-lg group hover:bg-pf-soft transition-colors"
        >
          <div className="mt-0.5 w-9 h-9 rounded-md bg-pf-soft border border-pf-border flex items-center justify-center text-pf-text group-hover:border-pf-accent group-hover:text-pf-accent">
            <Sparkles size={16} />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-pf-text">Lipsync Studio</div>
            <div className="text-xs text-pf-muted leading-snug mt-0.5">
              Image + audio + prompt → talking-head video.
            </div>
          </div>
        </Link>
        <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg opacity-50">
          <div className="mt-0.5 w-9 h-9 rounded-md bg-pf-soft border border-pf-border flex items-center justify-center text-pf-text">
            <Sparkles size={16} />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-pf-text flex items-center gap-2">
              Video generation
              <span className="text-[9px] text-pf-muted font-bold uppercase">Soon</span>
            </div>
            <div className="text-xs text-pf-muted leading-snug mt-0.5">
              T2V or I2V via Kling, Sora, Veo, Seedance.
            </div>
          </div>
        </div>
      </div>

      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[1.5px] text-pf-muted mb-4">
          Models
        </div>
        <div className="flex flex-col gap-1">
          {videoModels.map((m, i) => (
            <div
              key={i}
              className={`flex items-start gap-3 px-3 py-2.5 rounded-lg ${
                m.available ? "hover:bg-pf-soft cursor-pointer" : "opacity-50"
              }`}
            >
              <div className="relative mt-0.5">
                <div className="w-9 h-9 rounded-md bg-pf-soft border border-pf-border flex items-center justify-center font-bold text-pf-text">
                  {m.letter}
                </div>
                {m.badge && (
                  <div className="absolute -top-1.5 -left-1.5">
                    <Badge kind={m.badge} />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-pf-text">{m.label}</div>
                <div className="text-xs text-pf-muted leading-snug mt-0.5">
                  {m.description}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Generic wrapper that hovers a trigger and renders a menu under it.
type WrapperProps = {
  trigger: React.ReactNode;
  menu: React.ReactNode;
};

import { useState, useRef } from "react";

export function HoverMegaMenu({ trigger, menu }: WrapperProps) {
  const [open, setOpen] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEnter = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setOpen(true);
  };
  const handleLeave = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setOpen(false), 120);
  };

  return (
    <div className="relative" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      {trigger}
      {open && (
        <div className="absolute top-full left-0 pt-2 z-50">
          <div onMouseEnter={handleEnter}>{menu}</div>
        </div>
      )}
    </div>
  );
}
