import { NextRequest, NextResponse } from "next/server";

import { rehostToKie, submitTask } from "@/lib/kie";
import { VIDEO_CREATE_MODELS } from "@/lib/models";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = {
  startFrameUrl?: string;
  endFrameUrl?: string;
  prompt?: string;
  modelKey?: string;
  qualityLabel?: string;
  aspectRatio?: string;
  duration?: number | string;
  sound?: boolean;
};

function genBatchId() {
  return `vid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

  const startFrameUrl = (body.startFrameUrl || "").trim();
  const endFrameUrl = (body.endFrameUrl || "").trim();
  const prompt = (body.prompt || "").trim();
  const modelKey = body.modelKey || "kling-3-0-video";
  const qualityLabel = body.qualityLabel || "Pro";
  const aspectRatio = body.aspectRatio || "9:16";
  const duration = Number(body.duration) || 5;
  const sound = !!body.sound;

  if (!prompt) {
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  }
  if (!startFrameUrl) {
    return NextResponse.json({ error: "Start frame image is required" }, { status: 400 });
  }

  const model = VIDEO_CREATE_MODELS[modelKey];
  if (!model) {
    return NextResponse.json({ error: `Unknown video model: ${modelKey}` }, { status: 400 });
  }
  const quality = model.qualities.find((q) => q.label === qualityLabel) ?? model.qualities[0];

  if (!model.durations.includes(duration)) {
    return NextResponse.json(
      { error: `Duration must be one of ${model.durations.join(", ")}` },
      { status: 400 },
    );
  }
  if (!model.aspectRatios.includes(aspectRatio)) {
    return NextResponse.json(
      { error: `Aspect ratio must be one of ${model.aspectRatios.join(", ")}` },
      { status: 400 },
    );
  }

  const batchId = genBatchId();
  const itemId = genItemId();
  const supabase = createSupabaseAdminClient();

  const unitPrice = sound ? quality.pricePerSecondWithAudio : quality.pricePerSecondNoAudio;
  const estimatedCost = unitPrice * duration;

  const meta = {
    startFrameUrl,
    endFrameUrl: endFrameUrl || null,
    prompt,
    modelKey,
    qualityLabel: quality.label,
    aspectRatio,
    duration,
    sound,
  };

  const { error: batchErr } = await supabase.from("batches").insert({
    batch_id: batchId,
    kind: "video_create",
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

  // Kling 3.0 only fetches images hosted on KIE's whitelisted CDN — rehost
  // the user's Supabase URLs through KIE's file-stream-upload before submit.
  try {
    const imageUrls: string[] = [];
    if (startFrameUrl) imageUrls.push(await rehostToKie(startFrameUrl, "video-frames"));
    if (endFrameUrl) imageUrls.push(await rehostToKie(endFrameUrl, "video-frames"));

    const input: Record<string, unknown> = {
      prompt,
      sound,
      duration: String(duration),
      aspect_ratio: aspectRatio,
      mode: quality.kieMode,
      multi_shots: false,
      multi_prompt: [],
    };
    if (imageUrls.length > 0) input.image_urls = imageUrls;

    const taskId = await submitTask(model.kieModel, input);

    const { error: itemErr } = await supabase.from("items").insert({
      item_id: itemId,
      batch_id: batchId,
      idx: 0,
      status: "processing",
      input_url: startFrameUrl,
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
      input_url: startFrameUrl,
      output_url: null,
      error: String(e).slice(0, 500),
      kie_task_id: null,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
    });
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
