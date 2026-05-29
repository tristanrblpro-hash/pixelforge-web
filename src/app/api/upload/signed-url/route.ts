import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

// Mints a one-time signed upload URL so the browser can PUT a file
// directly to Supabase Storage. Bypasses Vercel's 4.5 MB request body
// cap (Hobby) on /api/upload — useful for cleaned WAVs that routinely
// land in the 8-20 MB range.
//
// The signed URL is bucket-scoped and expires after a short window, so
// the service role key never leaves the server.

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const BUCKET = "pixelforge-uploads";
const ALLOWED_PREFIXES = ["cut-silence", "voiceovers", "user-uploads", "user-frames"];

type Body = {
  path?: string;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const path = (body.path || "").trim();
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  if (path.includes("..") || path.startsWith("/")) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  const prefix = path.split("/")[0];
  if (!ALLOWED_PREFIXES.includes(prefix)) {
    return NextResponse.json(
      { error: `path prefix must be one of ${ALLOWED_PREFIXES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data) {
      return NextResponse.json(
        { error: `Supabase signed-url: ${error?.message || "unknown"}` },
        { status: 500 },
      );
    }
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return NextResponse.json({
      signedUrl: data.signedUrl,
      token: data.token,
      path,
      publicUrl: pub?.publicUrl || null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
