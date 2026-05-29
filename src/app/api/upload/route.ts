import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

// POST /api/upload
// Accepts a multipart form-data with a single "file" field, uploads to the
// pixelforge-uploads bucket and returns the public URL the frontend can
// pass to KIE as a reference image (input_urls / image_input).
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const BUCKET = "pixelforge-uploads";
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB (Supabase free-tier ceiling)

const ALLOWED_TYPES = [
  "image/png", "image/jpeg", "image/jpg", "image/webp",
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
  "audio/aac", "audio/mp4", "audio/ogg", "audio/webm",
  "video/mp4", "video/quicktime", "video/webm", "video/x-m4v",
] as const;

function extFromMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp") && mime.startsWith("image")) return "webp";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.startsWith("video/")) {
    if (mime.includes("quicktime")) return "mov";
    if (mime.includes("webm")) return "webm";
    if (mime.includes("m4v")) return "m4v";
    return "mp4";
  }
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("aac")) return "aac";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg")) return "ogg";
  return "bin";
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 50 MB)" }, { status: 413 });
  }
  const lower = file.type.toLowerCase();
  if (!ALLOWED_TYPES.includes(lower as typeof ALLOWED_TYPES[number])) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type}` },
      { status: 415 },
    );
  }

  const supabase = createSupabaseAdminClient();
  const ext = extFromMime(file.type);
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const path = `${id}.${ext}`;

  const buf = Buffer.from(await file.arrayBuffer());
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buf, { contentType: file.type, upsert: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) {
    return NextResponse.json({ error: "Failed to get public URL" }, { status: 500 });
  }

  return NextResponse.json({
    url: data.publicUrl,
    path,
    size: file.size,
    type: file.type,
  });
}
