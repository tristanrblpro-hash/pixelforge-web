import { NextRequest, NextResponse } from "next/server";

import { submitTask } from "@/lib/kie";
import { IMAGE_MODELS } from "@/lib/models";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel: allow up to 60s for the fan-out

type Body = {
  prompt?: string;
  modelKey?: string;
  aspectRatio?: string;
  quality?: string;
  count?: number;
};

function genBatchId() {
  // gen_<timestamp36>_<rand>
  return `gen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

  const prompt = (body.prompt || "").trim();
  const modelKey = body.modelKey || "nano-banana-pro";
  const aspectRatio = body.aspectRatio || "1:1";
  const quality = body.quality || "1K";
  const count = Math.max(1, Math.min(20, Number(body.count) || 1));

  if (!prompt) {
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  }

  const model = IMAGE_MODELS[modelKey];
  if (!model) {
    return NextResponse.json(
      { error: `Unknown image model: ${modelKey}` },
      { status: 400 },
    );
  }

  const batchId = genBatchId();
  const supabase = createSupabaseAdminClient();

  // 1. Persist the batch row first so /status can find it even if all submits fail.
  const meta = { prompt, modelKey, aspectRatio, quality, count };
  const estimatedCost = model.pricePerImage * count;
  const { error: batchErr } = await supabase.from("batches").insert({
    batch_id: batchId,
    kind: "image_gen",
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

  // 2. Fan-out submits to KIE in parallel.
  const submits = await Promise.allSettled(
    Array.from({ length: count }).map(async (_, idx) => {
      const itemId = genItemId();
      const taskId = await submitTask(model.kieModelT2I, {
        prompt,
        aspect_ratio: aspectRatio,
        image_size: quality, // KIE accepts "1K" / "2K" / "4K" — adjust if validation fails
      });
      return { itemId, idx, taskId };
    }),
  );

  // 3. Persist N items, capturing both successful submits and failed ones.
  const rows = submits.map((res, idx) => {
    if (res.status === "fulfilled") {
      return {
        item_id: res.value.itemId,
        batch_id: batchId,
        idx,
        status: "processing",
        input_url: null,
        output_url: null,
        error: null,
        kie_task_id: res.value.taskId,
        started_at: new Date().toISOString(),
        ended_at: null,
      };
    }
    return {
      item_id: genItemId(),
      batch_id: batchId,
      idx,
      status: "failed",
      input_url: null,
      output_url: null,
      error: String(res.reason).slice(0, 500),
      kie_task_id: null,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
    };
  });

  const { error: itemsErr } = await supabase.from("items").insert(rows);
  if (itemsErr) {
    return NextResponse.json(
      { error: "Failed to persist items", detail: itemsErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    batch_id: batchId,
    count: rows.length,
    submitted: rows.filter((r) => r.status === "processing").length,
    failed: rows.filter((r) => r.status === "failed").length,
    estimated_cost_usd: estimatedCost,
  });
}
