import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 60));
  const kind = url.searchParams.get("kind") || "image_gen";

  const supabase = createSupabaseAdminClient();

  // Get the most recent batches of the requested kind, then their items in one query.
  const { data: batches } = await supabase
    .from("batches")
    .select("batch_id,kind,model,status,created_at,meta_json")
    .eq("kind", kind)
    .order("created_at", { ascending: false })
    .limit(30);

  if (!batches || batches.length === 0) {
    return NextResponse.json({ items: [] });
  }

  const batchIds = batches.map((b) => b.batch_id);
  const batchByid = Object.fromEntries(batches.map((b) => [b.batch_id, b]));

  const { data: items } = await supabase
    .from("items")
    .select("item_id,batch_id,idx,status,output_url,started_at,ended_at")
    .in("batch_id", batchIds)
    .neq("status", "cancelled")
    .order("ended_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  const enriched = (items || []).map((i) => {
    const b = batchByid[i.batch_id] || {};
    const meta = (b.meta_json || {}) as Record<string, unknown>;
    return {
      item_id: i.item_id,
      batch_id: i.batch_id,
      idx: i.idx,
      status: i.status,
      output_url: i.output_url,
      created_at: i.started_at || (b.created_at as string | undefined),
      ended_at: i.ended_at,
      prompt: meta.prompt as string | undefined,
      model_key: meta.modelKey as string | undefined,
      aspect_ratio: meta.aspectRatio as string | undefined,
    };
  });

  return NextResponse.json({ items: enriched });
}
