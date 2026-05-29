"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Download, Copy as CopyIcon, Paperclip } from "lucide-react";
import type { GalleryItem } from "./Gallery";
import {
  type AttachTarget,
  applyAttach,
  clearAttachTarget,
  getAttachTarget,
  loadBrief,
} from "@/lib/briefs";
import { AttachToBriefButton } from "@/components/AttachToBriefButton";

type Props = {
  item: GalleryItem | null;
  onClose: () => void;
};

async function triggerDownload(url: string, filename: string) {
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
  } catch {
    window.open(url, "_blank");
  }
}

function aspectMaxWidth(ratio?: string | null): string {
  switch (ratio) {
    case "9:16": return "max-w-[420px]";
    case "16:9": return "max-w-[1100px]";
    case "21:9": return "max-w-[1300px]";
    case "3:4":  return "max-w-[520px]";
    case "4:5":  return "max-w-[600px]";
    case "2:3":  return "max-w-[560px]";
    case "1:1":
    default:     return "max-w-[760px]";
  }
}

function isVideoUrl(url: string): boolean {
  const u = url.toLowerCase();
  return u.includes(".mp4") || u.includes(".webm") || u.includes(".mov") || u.includes("/pixelforge-videos/");
}

export function ImagePreviewModal({ item, onClose }: Props) {
  const router = useRouter();
  const [attachTarget, setAttachTargetState] = useState<AttachTarget | null>(null);
  const [attachBriefTitle, setAttachBriefTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!item) {
      setAttachTargetState(null);
      setAttachBriefTitle(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    // Detect brief attach intent when the modal opens.
    const t = getAttachTarget();
    if (t && t.kind === "avatarImage") {
      const b = loadBrief(t.briefId);
      if (b) {
        const h = b.hooks.find((x) => x.id === t.hookId);
        setAttachTargetState(t);
        setAttachBriefTitle(`${b.adsetName}${h ? ` — Hook ${h.index}` : ""}`);
      }
    }
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
    };
  }, [item, onClose]);

  const handleAttachToBrief = () => {
    if (!attachTarget || !item?.output_url) return;
    applyAttach(attachTarget, {
      url: item.output_url,
      prompt: item.prompt ?? undefined,
    });
    clearAttachTarget();
    router.push(`/briefs/${attachTarget.briefId}`);
  };

  if (!item || !item.output_url) return null;

  const widthClass = aspectMaxWidth(item.aspect_ratio);
  const video = isVideoUrl(item.output_url);
  const fileExt = video ? "mp4" : "png";

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/85 backdrop-blur-md flex items-center justify-center p-6"
      onClick={onClose}
    >
      {/* Close button */}
      <button
        type="button"
        onClick={onClose}
        className="absolute top-5 right-5 w-9 h-9 rounded-full bg-pf-elev border border-pf-border text-pf-text hover:bg-pf-soft flex items-center justify-center"
        aria-label="Close"
      >
        <X size={18} />
      </button>

      <div className="grid lg:grid-cols-[1fr_360px] gap-6 w-full max-w-[1400px] max-h-[calc(100vh-3rem)]">
        {/* Image / video — click only the media itself stops propagation */}
        <div className="flex items-center justify-center min-h-0">
          {video ? (
            <video
              src={item.output_url}
              controls
              autoPlay
              playsInline
              onClick={(e) => e.stopPropagation()}
              className={`w-full ${widthClass} h-auto max-h-[calc(100vh-6rem)] object-contain rounded-lg bg-black`}
            />
          ) : (
            <img
              src={item.output_url}
              alt={item.prompt ?? "generated"}
              onClick={(e) => e.stopPropagation()}
              className={`w-full ${widthClass} h-auto max-h-[calc(100vh-6rem)] object-contain rounded-lg`}
            />
          )}
        </div>

        {/* Side panel */}
        <aside
          className="bg-pf-elev border border-pf-border rounded-xl p-5 overflow-y-auto max-h-[calc(100vh-6rem)]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-5">
            <div className="text-[10px] font-semibold tracking-[1.5px] uppercase text-pf-muted">
              Prompt
            </div>
            {item.prompt && (
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(item.prompt ?? "")}
                className="text-xs flex items-center gap-1 text-pf-dim hover:text-pf-text"
              >
                <CopyIcon size={12} /> Copy
              </button>
            )}
          </div>
          <p className="text-sm text-pf-text whitespace-pre-wrap leading-relaxed max-h-[40vh] overflow-y-auto pr-2 break-words">
            {item.prompt || <span className="text-pf-muted">(no prompt)</span>}
          </p>

          <div className="text-[10px] font-semibold tracking-[1.5px] uppercase text-pf-muted mt-8 mb-3">
            Information
          </div>
          <div className="space-y-2 text-sm">
            <Row label="Model"        value={item.model_key ?? "—"} />
            <Row label="Aspect ratio" value={item.aspect_ratio ?? "—"} />
            <Row label="Item id"      value={item.item_id} mono />
          </div>

          {attachTarget && attachBriefTitle ? (
            <button
              type="button"
              onClick={handleAttachToBrief}
              className="mt-7 w-full flex items-center justify-center gap-2 bg-pf-accent text-pf-accent-fg font-semibold rounded-lg py-2.5 hover:opacity-90"
              title={`Attach au brief ${attachBriefTitle}`}
            >
              <Paperclip size={14} />
              Attach → {attachBriefTitle}
            </button>
          ) : null}

          {/* Universal attach — works whether or not a preset target exists.
              When preset is set, this acts as the "attach somewhere else" path. */}
          <div className={attachTarget ? "mt-3" : "mt-7"}>
            <AttachToBriefButton
              asset={{
                kind: video ? "video" : "image",
                url: item.output_url,
                prompt: item.prompt ?? undefined,
              }}
              label={attachTarget ? "Rattacher à un autre brief" : "Rattacher à un brief"}
              size="md"
              className={`w-full flex items-center justify-center gap-2 ${
                attachTarget
                  ? "bg-pf-soft border border-pf-border text-pf-text hover:border-pf-accent"
                  : "bg-pf-accent text-pf-accent-fg hover:opacity-90"
              } font-semibold rounded-lg py-2.5`}
            />
          </div>

          <button
            type="button"
            onClick={() => triggerDownload(item.output_url!, `${item.item_id}.${fileExt}`)}
            className="mt-3 w-full flex items-center justify-center gap-2 bg-pf-soft border border-pf-border text-pf-text hover:border-pf-accent font-semibold rounded-lg py-2.5"
          >
            <Download size={16} />
            Download
          </button>
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-pf-muted">{label}</span>
      <span className={`text-pf-text ${mono ? "font-mono text-xs" : ""} truncate text-right`}>
        {value}
      </span>
    </div>
  );
}
