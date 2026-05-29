import { LIPSYNC_MODELS, VIDEO_CREATE_MODELS } from "@/lib/models";
import { VideoTabs } from "@/components/VideoTabs";
import { WorkspaceHeader } from "@/components/ModelCard";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { GalleryItem } from "@/components/Gallery";

export const dynamic = "force-dynamic";

async function fetchRecentByKind(kind: string, fallbackRatio = "9:16"): Promise<GalleryItem[]> {
  try {
    const supabase = createSupabaseAdminClient();
    const { data: batches } = await supabase
      .from("batches")
      .select("batch_id,kind,model,status,created_at,meta_json")
      .eq("kind", kind)
      .order("created_at", { ascending: false })
      .limit(30);
    if (!batches || batches.length === 0) return [];
    const batchById = Object.fromEntries(batches.map((b) => [b.batch_id, b]));

    const { data: items } = await supabase
      .from("items")
      .select("item_id,batch_id,idx,status,output_url,started_at,ended_at,error")
      .in("batch_id", batches.map((b) => b.batch_id))
      .neq("status", "cancelled")
      .order("ended_at", { ascending: false, nullsFirst: false })
      .limit(60);

    return (items || []).map((i) => {
      const b = batchById[i.batch_id];
      const meta = (b?.meta_json || {}) as {
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
        aspect_ratio: meta.aspectRatio ?? fallbackRatio,
        model_key: meta.modelKey ?? null,
      } satisfies GalleryItem;
    });
  } catch (e) {
    console.error(`fetchRecentByKind(${kind}) failed:`, e);
    return [];
  }
}

export default async function VideoPage() {
  const [videoCreateItems, lipsyncItems] = await Promise.all([
    fetchRecentByKind("video_create", "9:16"),
    fetchRecentByKind("lipsync", "9:16"),
  ]);

  const videoCreateModels = Object.entries(VIDEO_CREATE_MODELS).map(([key, m]) => ({
    key,
    label: m.label,
    vendor: m.vendor,
    aspectRatios: m.aspectRatios,
    durations: m.durations,
    qualities: m.qualities.map((q) => ({
      label: q.label,
      displayLabel: q.displayLabel,
      resolution: q.resolution,
      pricePerSecondNoAudio: q.pricePerSecondNoAudio,
      pricePerSecondWithAudio: q.pricePerSecondWithAudio,
    })),
    supportsEndFrame: m.supportsEndFrame,
    supportsSound: m.supportsSound,
    pricingNote: m.pricingNote,
  }));

  const lipsyncModels = Object.entries(LIPSYNC_MODELS).map(([key, m]) => ({
    key,
    label: m.label,
    vendor: m.vendor,
    maxAudioSeconds: m.maxAudioSeconds,
    qualities: m.qualities.map((q) => ({
      label: q.label,
      resolution: q.resolution,
      fps: q.fps,
      pricePerSecond: q.pricePerSecond,
    })),
  }));

  return (
    <>
      <WorkspaceHeader
        title="Video"
        lede="Generate videos from images or animate avatars with lipsync."
      />
      <VideoTabs
        videoCreateModels={videoCreateModels}
        lipsyncModels={lipsyncModels}
        videoCreateItems={videoCreateItems}
        lipsyncItems={lipsyncItems}
      />
    </>
  );
}
