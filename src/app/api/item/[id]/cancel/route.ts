import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

// Soft cancel: marks the item as 'cancelled' in Supabase so it disappears from
// the gallery. KIE.ai has no cancel endpoint — the underlying generation will
// still run and be billed; this just removes it from the user's view.
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: RouteContext) {
  const { id: itemId } = await ctx.params;
  if (!itemId) return NextResponse.json({ error: "Missing item id" }, { status: 400 });

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("items")
    .update({
      status: "cancelled",
      ended_at: new Date().toISOString(),
      error: "cancelled by user",
    })
    .eq("item_id", itemId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
