"use client";

import { Download, Loader2, AlertCircle } from "lucide-react";

export type GalleryItem = {
  item_id: string;
  batch_id?: string;
  idx?: number;
  status: "queued" | "processing" | "done" | "failed";
  output_url?: string | null;
  prompt?: string | null;
  aspect_ratio?: string | null;
  model_key?: string | null;
  error?: string | null;
};

function aspectToClass(ratio?: string | null): string {
  switch (ratio) {
    case "9:16": return "aspect-[9/16]";
    case "16:9": return "aspect-[16/9]";
    case "4:3":  return "aspect-[4/3]";
    case "3:4":  return "aspect-[3/4]";
    case "3:2":  return "aspect-[3/2]";
    case "2:3":  return "aspect-[2/3]";
    default:     return "aspect-square";
  }
}

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
    // fallback: open in new tab
    window.open(url, "_blank");
  }
}

function Card({ item }: { item: GalleryItem }) {
  const ratioClass = aspectToClass(item.aspect_ratio);

  if (item.status === "done" && item.output_url) {
    return (
      <div className={`group relative bg-pf-elev border border-pf-border rounded-lg overflow-hidden ${ratioClass}`}>
        <img
          src={item.output_url}
          alt={item.prompt ?? "generated"}
          className="absolute inset-0 w-full h-full object-cover"
        />
        <button
          type="button"
          onClick={() => triggerDownload(item.output_url!, `${item.item_id}.png`)}
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-pf-bg/80 backdrop-blur-sm border border-pf-border rounded-md p-1.5 hover:bg-pf-accent hover:text-pf-accent-fg"
          aria-label="Download"
        >
          <Download size={14} />
        </button>
        {item.prompt && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-pf-bg/95 via-pf-bg/60 to-transparent p-3 opacity-0 group-hover:opacity-100 transition-opacity">
            <p className="text-xs text-pf-text line-clamp-3">{item.prompt}</p>
          </div>
        )}
      </div>
    );
  }

  if (item.status === "failed") {
    return (
      <div className={`relative bg-pf-elev border border-pf-danger/50 rounded-lg overflow-hidden ${ratioClass}`}>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-pf-danger text-center px-4">
          <AlertCircle size={24} className="mb-2" />
          <span className="text-xs font-semibold">Failed</span>
          {item.error && <span className="text-[10px] text-pf-muted mt-1 line-clamp-2">{item.error}</span>}
        </div>
      </div>
    );
  }

  // queued / processing
  return (
    <div className={`relative bg-pf-elev border border-pf-border rounded-lg overflow-hidden ${ratioClass}`}>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-pf-muted">
        <Loader2 size={24} className="animate-spin mb-2" />
        <span className="text-xs">{item.status}</span>
      </div>
    </div>
  );
}

export function Gallery({ items }: { items: GalleryItem[] }) {
  if (items.length === 0) {
    return (
      <div className="border border-dashed border-pf-border rounded-lg py-20 text-center text-pf-muted">
        No images yet. Write a prompt below and hit <span className="text-pf-accent">Generate</span>.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 pb-44">
      {items.map((it) => (
        <Card key={it.item_id} item={it} />
      ))}
    </div>
  );
}
