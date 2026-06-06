import { NextRequest, NextResponse } from "next/server";

import { fetchYoutubeTranscript } from "@/lib/youtubeTranscript";

export const dynamic = "force-dynamic";
// Captions extraction is usually under 5 s (one HTTP call to the YouTube
// watch page + one to the caption track endpoint). Cap at 60 s in case
// the watch page is slow to render or the user gave us a redirector URL.
export const maxDuration = 60;

type Body = {
  url?: string;
  preferLangs?: string[];
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const url = (body.url || "").trim();
  if (!url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  // Validate preferLangs lightly so bad client data doesn't break the
  // helper's track-selection heuristic.
  const preferLangs =
    Array.isArray(body.preferLangs) &&
    body.preferLangs.every((s) => typeof s === "string" && s.length <= 16)
      ? body.preferLangs
      : ["en", "fr"];

  try {
    const result = await fetchYoutubeTranscript(url, preferLangs);
    return NextResponse.json(result);
  } catch (e) {
    console.error("/api/transcribe/youtube error", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message.slice(0, 500) }, { status: 502 });
  }
}
