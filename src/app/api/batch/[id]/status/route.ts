import { NextResponse } from "next/server";

import { extractResultUrls, fetchTask, normalizeState } from "@/lib/kie";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STORAGE_BUCKET = "pixelforge-images";

type RouteContext = { params: Promise<{ id: string }> };

// Download a KIE result URL and re-upload it to Supabase Storage so we keep
// a permanent copy beyond KIE's ~24h URL expiry. Returns the new public URL,
// or falls back to the original KIE URL on any error so the user still sees
// the image immediately.
async function archiveToStorage(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  kieUrl: string,
  storagePath: string,
): Promise<string> {
  try {
    const r = await fetch(kieUrl);
    if (!r.ok) return kieUrl;
    const contentType = r.headers.get("content-type") || "image/png";
    const buf = Buffer.from(await r.arrayBuffer());
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, buf, { contentType, upsert: true });
    if (error) {
      console.error("storage upload error", error);
      return kieUrl;
    }
    const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
    return data.publicUrl || kieUrl;
  } catch (e) {
    console.error("archiveToStorage error", e);
    return kieUrl;
  }
}

export async function GET(_req: Request, ctx: RouteContext) {
  const { id: batchId } = await ctx.params;
  if (!batchId) return NextResponse.json({ error: "Missing batch id" }, { status: 400 });

  const supabase = createSupabaseAdminClient();

  const { data: batch } = await supabase
    .from("batches")
    .select("batch_id,kind,model,status,cost_usd,meta_json,created_at,updated_at")
    .eq("batch_id", batchId)
    .maybeSingle();
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  const { data: items } = await supabase
    .from("items")
    .select("item_id,idx,status,output_url,error,kie_task_id,started_at,ended_at")
    .eq("batch_id", batchId)
    .order("idx", { ascending: true });

  const itemsList = items || [];
  const stillProcessing = itemsList.filter((i) => i.status === "processing" && i.kie_task_id);

  if (stillProcessing.length > 0) {
    await Promise.all(
      stillProcessing.map(async (item) => {
        try {
          const record = await fetchTask(item.kie_task_id as string);
          const state = normalizeState(record);
          if (state === "success") {
            const urls = extractResultUrls(record);
            const kieUrl = urls[0] || null;
            let finalUrl: string | null = kieUrl;
            if (kieUrl) {
              const ext = kieUrl.includes(".webp") ? "webp" : kieUrl.includes(".jpg") || kieUrl.includes(".jpeg") ? "jpg" : "png";
              finalUrl = await archiveToStorage(supabase, kieUrl, `${batchId}/${item.item_id}.${ext}`);
            }
            await supabase
              .from("items")
              .update({
                status: "done",
                output_url: finalUrl,
                ended_at: new Date().toISOString(),
              })
              .eq("item_id", item.item_id);
            item.status = "done";
            item.output_url = finalUrl;
          } else if (state === "fail") {
            const err = (record.error as string) || (record.errorMessage as string) || "kie task failed";
            await supabase
              .from("items")
              .update({
                status: "failed",
                error: err.slice(0, 500),
                ended_at: new Date().toISOString(),
              })
              .eq("item_id", item.item_id);
            item.status = "failed";
            item.error = err;
          }
        } catch (e) {
          console.error("KIE poll error", item.item_id, e);
        }
      }),
    );
  }

  const allDone = itemsList.every((i) => i.status === "done" || i.status === "failed");
  const anyFailed = itemsList.some((i) => i.status === "failed");
  let batchStatus = batch.status;
  if (allDone && batch.status === "running") {
    batchStatus = anyFailed && itemsList.every((i) => i.status === "failed") ? "failed" : "completed";
    await supabase
      .from("batches")
      .update({ status: batchStatus, updated_at: new Date().toISOString() })
      .eq("batch_id", batchId);
  }

  return NextResponse.json({
    batch_id: batchId,
    status: batchStatus,
    cost_usd: batch.cost_usd,
    meta: batch.meta_json,
    items: itemsList.map((i) => ({
      item_id: i.item_id,
      idx: i.idx,
      status: i.status,
      output_url: i.output_url,
      error: i.error,
    })),
  });
}
