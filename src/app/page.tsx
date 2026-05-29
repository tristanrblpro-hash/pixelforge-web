import { IMAGE_MODELS } from "@/lib/models";
import { HomeStudio } from "@/components/HomeStudio";
import { WorkspaceHeader } from "@/components/ModelCard";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { GalleryItem } from "@/components/Gallery";

// Always re-render at request time so newly persisted batches show up on reload.
export const dynamic = "force-dynamic";

async function fetchRecentItems(): Promise<GalleryItem[]> {
  // Query Supabase directly instead of self-fetching the API route.
  // Self-fetches via VERCEL_URL are fragile (cold starts, URL drift between
  // preview/prod) and add latency.
  try {
    const supabase = createSupabaseAdminClient();
    const { data: batches } = await supabase
      .from("batches")
      .select("batch_id,kind,model,status,created_at,meta_json")
      .eq("kind", "image_gen")
      .order("created_at", { ascending: false })
      .limit(30);
    if (!batches || batches.length === 0) return [];

    const batchById: Record<string, (typeof batches)[number]> = Object.fromEntries(
      batches.map((b) => [b.batch_id, b]),
    );

    const { data: items } = await supabase
      .from("items")
      .select("item_id,batch_id,idx,status,output_url,started_at,ended_at,error")
      .in(
        "batch_id",
        batches.map((b) => b.batch_id),
      )
      .neq("status", "cancelled")
      .order("ended_at", { ascending: false, nullsFirst: false })
      .limit(60);

    return (items || []).map((i) => {
      const b = batchById[i.batch_id] || ({} as (typeof batches)[number]);
      const meta = (b.meta_json || {}) as {
        prompt?: string;
        modelKey?: string;
        aspectRatio?: string;
      };
      return {
        item_id: i.item_id,
        batch_id: i.batch_id,
        idx: i.idx ?? undefined,
        status: i.status,
        output_url: i.output_url,
        error: i.error,
        prompt: meta.prompt ?? null,
        aspect_ratio: meta.aspectRatio ?? null,
        model_key: meta.modelKey ?? null,
      } satisfies GalleryItem;
    });
  } catch (e) {
    console.error("fetchRecentItems failed:", e);
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
    pricing: m.pricing,
    defaultPricePerImage: m.defaultPricePerImage,
    pricingNote: m.pricingNote,
    maxInputImages: m.maxInputImages,
    badge: m.badge,
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
