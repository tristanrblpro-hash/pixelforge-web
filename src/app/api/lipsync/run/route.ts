import { NextRequest, NextResponse } from "next/server";

import { rehostToKie, submitTask } from "@/lib/kie";
import { LIPSYNC_MODELS } from "@/lib/models";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = {
  imageUrl?: string;
  audioUrl?: string;
  prompt?: string;
  modelKey?: string;
  qualityLabel?: string; // "Pro" | "Standard"
  audioDurationSec?: number;
};

function genBatchId() {
  return `lip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function genItemId() {
  return `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const imageUrl = (body.imageUrl || "").trim();
  const audioUrl = (body.audioUrl || "").trim();
  const prompt = (body.prompt || "").trim();
  const modelKey = body.modelKey || "kling-avatars-2";
  const qualityLabel = body.qualityLabel || "Pro";

  if (!imageUrl) return NextResponse.json({ error: "Image URL is required" }, { status: 400 });
  if (!audioUrl) return NextResponse.json({ error: "Audio URL is required" }, { status: 400 });

  const model = LIPSYNC_MODELS[modelKey];
  if (!model) {
    return NextResponse.json({ error: `Unknown lipsync model: ${modelKey}` }, { status: 400 });
  }

  const quality = model.qualities.find((q) => q.label === qualityLabel) ?? model.qualities[0];
  if (!quality) {
    return NextResponse.json({ error: `Unknown quality: ${qualityLabel}` }, { status: 400 });
  }

  if (body.audioDurationSec && body.audioDurationSec > model.maxAudioSeconds) {
    return NextResponse.json(
      {
        error: `Audio is ${Math.round(body.audioDurationSec)}s — ${model.label} accepts at most ${model.maxAudioSeconds}s.`,
      },
      { status: 400 },
    );
  }

  const batchId = genBatchId();
  const itemId = genItemId();
  const supabase = createSupabaseAdminClient();

  const audioSec = Math.max(1, Math.round(body.audioDurationSec || 10));
  const estimatedCost = quality.pricePerSecond * audioSec;

  const meta = {
    imageUrl,
    audioUrl,
    prompt,
    modelKey,
    qualityLabel: quality.label,
    resolution: quality.resolution,
    audioDurationSec: audioSec,
  };
  const { error: batchErr } = await supabase.from("batches").insert({
    batch_id: batchId,
    kind: "lipsync",
    model: modelKey,
    status: "running",
    cost_usd: estimatedCost,
    meta_json: meta,
  });
  if (batchErr) {
    return NextResponse.json(
      { error: "Failed to create batch", detail: batchErr.message },
      { status: 500 },
    );
  }

  try {
    // Kling lipsync only accepts media on KIE's whitelisted CDN — rehost
    // the user's Supabase URLs before submitting.
    const [kieImageUrl, kieAudioUrl] = await Promise.all([
      rehostToKie(imageUrl, "lipsync-images"),
      rehostToKie(audioUrl, "lipsync-audio"),
    ]);

    const taskId = await submitTask(quality.kieModel, {
      image_url: kieImageUrl,
      audio_url: kieAudioUrl,
      prompt,
    });

    const { error: itemErr } = await supabase.from("items").insert({
      item_id: itemId,
      batch_id: batchId,
      idx: 0,
      status: "processing",
      input_url: imageUrl,
      output_url: null,
      error: null,
      kie_task_id: taskId,
      started_at: new Date().toISOString(),
    });
    if (itemErr) {
      return NextResponse.json(
        { error: "Failed to persist item", detail: itemErr.message },
        { status: 500 },
      );
    }

    return NextResponse.json({
      batch_id: batchId,
      task_id: taskId,
      estimated_cost_usd: estimatedCost,
    });
  } catch (e) {
    await supabase
      .from("batches")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("batch_id", batchId);
    await supabase.from("items").insert({
      item_id: itemId,
      batch_id: batchId,
      idx: 0,
      status: "failed",
      input_url: imageUrl,
      output_url: null,
      error: String(e).slice(0, 500),
      kie_task_id: null,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
    });
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
