import { IMAGE_MODELS } from "@/lib/models";
import { HomeStudio } from "@/components/HomeStudio";
import { WorkspaceHeader } from "@/components/ModelCard";
import type { GalleryItem } from "@/components/Gallery";

async function fetchRecentItems(): Promise<GalleryItem[]> {
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";
  try {
    const r = await fetch(`${base}/api/items/recent?kind=image_gen&limit=60`, { cache: "no-store" });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.items || []) as GalleryItem[];
  } catch {
    return [];
  }
}

export default async function Home() {
  const initialItems = await fetchRecentItems();

  const models = Object.entries(IMAGE_MODELS).map(([key, m]) => ({
    key,
    label: m.label,
    vendor: m.vendor,
    aspectRatios: m.aspectRatios,
    qualities: m.qualities,
    pricePerImage: m.pricePerImage,
  }));

  return (
    <>
      <WorkspaceHeader
        title="Image generation"
        lede="Generate images from text prompts. Up to 20 in parallel per run."
      />
      <HomeStudio models={models} initialItems={initialItems} />
    </>
  );
}
