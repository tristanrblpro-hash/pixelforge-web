import { NextRequest, NextResponse } from "next/server";

import {
  ElevenAuthError,
  ElevenNoCreditsError,
  splitForTts,
  textToSpeech,
} from "@/lib/elevenLabs";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// Eleven v3 + long scripts (2-3k chars) can run 45-120s server-side.
// 300s is the Vercel Pro ceiling; Hobby still caps to 60s but the line is
// harmless when the plan doesn't allow it.
export const maxDuration = 300;

const BUCKET = "pixelforge-uploads";

type Body = {
  voiceId?: string;
  voiceName?: string;
  text?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
};

function genId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const voiceId = (body.voiceId || "").trim();
  const text = (body.text || "").trim();
  if (!voiceId) {
    return NextResponse.json({ error: "voiceId is required" }, { status: 400 });
  }
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  if (text.length > 8000) {
    return NextResponse.json(
      { error: "text too long (max 8000 chars per request)" },
      { status: 400 },
    );
  }

  try {
    // 1. Synthesize audio. Long scripts are auto-chunked and the chunks are
    //    fired in parallel so the wall-clock time = max(chunk_time) instead
    //    of sum(chunk_time). That keeps V3 under Vercel's 60s Hobby cap
    //    even on 2-3k-char ad scripts.
    const voiceSettings = {
      stability: body.stability,
      similarityBoost: body.similarityBoost,
      style: body.style,
      useSpeakerBoost: body.useSpeakerBoost,
    };

    // V2 / turbo / flash all comfortably handle 1500-char chunks under
    // Vercel's 60s cap when fired in parallel.
    const chunkSize = 1500;
    const chunks = splitForTts(text, chunkSize);

    let audio: ArrayBuffer;
    let contentType = "audio/mpeg";

    if (chunks.length === 1) {
      const res = await textToSpeech({
        voiceId,
        text: chunks[0],
        modelId: body.modelId,
        voiceSettings,
      });
      audio = res.audio;
      contentType = res.contentType;
    } else {
      // Parallel generation. We pass previous_text / next_text to keep
      // prosody continuous across the seams when we byte-concat the MP3s
      // (ElevenLabs MP3 output is CBR 128kbps with no embedded ID3 tags,
      // so naive concat plays back fine on every common player).
      const results = await Promise.all(
        chunks.map((c, i) =>
          textToSpeech({
            voiceId,
            text: c,
            modelId: body.modelId,
            voiceSettings,
            previousText: chunks.slice(0, i).join(" "),
            nextText: chunks.slice(i + 1).join(" "),
          }),
        ),
      );
      contentType = results[0].contentType;
      const total = results.reduce((s, r) => s + r.audio.byteLength, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const r of results) {
        merged.set(new Uint8Array(r.audio), off);
        off += r.audio.byteLength;
      }
      audio = merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength);
    }

    // 2. Persist to Supabase Storage so we have a stable URL beyond this
    //    request, and so downstream tools (Cut Silence, Lipsync) can fetch
    //    the audio without re-billing ElevenLabs.
    const id = genId("vo");
    const voiceSlug = slugify(body.voiceName || "voice");
    const path = `voiceovers/${voiceSlug}_${id}.mp3`;
    const supabase = createSupabaseAdminClient();
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, Buffer.from(audio), { contentType, upsert: false });
    if (upErr) {
      console.error("supabase upload error", upErr);
      return NextResponse.json(
        { error: `Supabase upload failed: ${upErr.message}` },
        { status: 500 },
      );
    }
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
    const url = pub?.publicUrl || "";
    if (!url) {
      return NextResponse.json({ error: "No public URL after upload" }, { status: 500 });
    }

    return NextResponse.json({
      id,
      url,
      path,
      size: audio.byteLength,
      contentType,
      charCount: text.length,
      chunkCount: chunks.length,
    });
  } catch (e) {
    if (e instanceof ElevenAuthError) {
      return NextResponse.json({ error: e.message }, { status: 401 });
    }
    if (e instanceof ElevenNoCreditsError) {
      return NextResponse.json({ error: e.message }, { status: 402 });
    }
    console.error("/api/voiceover/generate error", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
