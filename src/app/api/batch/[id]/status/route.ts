import { NextResponse } from "next/server";

import { extractResultUrls, fetchTask, normalizeState } from "@/lib/kie";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const IMAGE_BUCKET = "pixelforge-images";
const VIDEO_BUCKET = "pixelforge-videos";

type RouteContext = { params: Promise<{ id: string }> };

function detectMediaKind(url: string, contentType: string): { kind: "image" | "video"; ext: string } {
  const u = url.toLowerCase();
  const c = contentType.toLowerCase();
  if (c.startsWith("video/") || u.includes(".mp4") || u.includes(".mov") || u.includes(".webm")) {
    if (u.includes(".webm") || c.includes("webm")) return { kind: "video", ext: "webm" };
    if (u.includes(".mov") || c.includes("quicktime")) return { kind: "video", ext: "mov" };
    return { kind: "video", ext: "mp4" };
  }
  if (u.includes(".webp") || c.includes("webp")) return { kind: "image", ext: "webp" };
  if (u.includes(".jpg") || u.includes(".jpeg") || c.includes("jpeg")) return { kind: "image", ext: "jpg" };
  return { kind: "image", ext: "png" };
}

// Download a KIE result URL and re-upload it to Supabase Storage so we keep a
// permanent copy beyond KIE's ~24h URL expiry. Falls back to the original KIE
// URL on any failure so the user still sees the output immediately.
async function archiveToStorage(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  kieUrl: string,
  batchId: string,
  itemId: string,
): Promise<string> {
  try {
    const r = await fetch(kieUrl);
    if (!r.ok) return kieUrl;
    const contentType = r.headers.get("content-type") || "image/png";
    const { kind, ext } = detectMediaKind(kieUrl, contentType);
    const bucket = kind === "video" ? VIDEO_BUCKET : IMAGE_BUCKET;
    const storagePath = `${batchId}/${itemId}.${ext}`;
    const buf = Buffer.from(await r.arrayBuffer());
    const { error } = await supabase.storage
      .from(bucket)
      .upload(storagePath, buf, { contentType, upsert: true });
    if (error) {
      console.error("storage upload error", error);
      return kieUrl;
    }
    const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
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
              finalUrl = await archiveToStorage(supabase, kieUrl, batchId, item.item_id);
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
            const failMsg =
              (record.failMsg as string) ||
              (record.error as string) ||
              (record.errorMessage as string) ||
              "kie task failed";
            const failCode = (record.failCode as string) || "";
            const err = failCode ? `[${failCode}] ${failMsg}` : failMsg;
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
