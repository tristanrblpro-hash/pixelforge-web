import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("batches")
      .select("batch_id,kind,status,cost_usd,created_at")
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      // Table likely doesn't exist yet — return an empty list rather than a 500
      // so the UI can render its empty state.
      return NextResponse.json({ batches: [], note: error.message });
    }
    return NextResponse.json({ batches: data ?? [] });
  } catch (e) {
    return NextResponse.json(
      { batches: [], error: String(e) },
      { status: 200 },
    );
  }
}
