"use client";

import { useState } from "react";
import { CreateVideoStudio } from "./CreateVideoStudio";
import { LipsyncStudio } from "./LipsyncStudio";
import type { GalleryItem } from "./Gallery";

type VideoCreateModelInfo = {
  key: string;
  label: string;
  vendor: string;
  aspectRatios: string[];
  durations: number[];
  qualities: Array<{
    label: string;
    displayLabel: string;
    resolution: string;
    pricePerSecondNoAudio: number;
    pricePerSecondWithAudio: number;
  }>;
  supportsEndFrame: boolean;
  supportsSound: boolean;
  pricingNote?: string;
};

type LipsyncModelInfo = {
  key: string;
  label: string;
  vendor: string;
  maxAudioSeconds: number;
  qualities: Array<{
    label: string;
    resolution: string;
    fps: number;
    pricePerSecond: number;
  }>;
};

type Props = {
  videoCreateModels: VideoCreateModelInfo[];
  lipsyncModels: LipsyncModelInfo[];
  videoCreateItems: GalleryItem[];
  lipsyncItems: GalleryItem[];
};

type Tab = "create" | "lipsync";

export function VideoTabs({
  videoCreateModels,
  lipsyncModels,
  videoCreateItems,
  lipsyncItems,
}: Props) {
  const [tab, setTab] = useState<Tab>("create");

  return (
    <>
      <div className="flex items-center gap-1 mb-6 border-b border-pf-border">
        <TabButton active={tab === "create"} onClick={() => setTab("create")}>
          Create Video
        </TabButton>
        <TabButton active={tab === "lipsync"} onClick={() => setTab("lipsync")}>
          Lipsync Studio
        </TabButton>
      </div>

      {tab === "create" ? (
        <CreateVideoStudio models={videoCreateModels} initialItems={videoCreateItems} />
      ) : (
        <LipsyncStudio models={lipsyncModels} initialItems={lipsyncItems} />
      )}
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors -mb-px ${
        active
          ? "text-pf-text border-pf-accent"
          : "text-pf-muted hover:text-pf-text border-transparent"
      }`}
    >
      {children}
    </button>
  );
}
