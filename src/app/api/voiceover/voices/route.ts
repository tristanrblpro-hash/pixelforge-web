import { NextResponse } from "next/server";

import {
  ElevenAuthError,
  getSubscription,
  listVoices,
} from "@/lib/elevenLabs";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    // Fetch voices and the user's character balance in parallel.
    const [voices, subscription] = await Promise.all([
      listVoices(),
      getSubscription().catch(() => null), // optional, don't fail page load
    ]);
    return NextResponse.json({
      voices,
      subscription,
    });
  } catch (e) {
    const status = e instanceof ElevenAuthError ? 401 : 502;
    console.error("/api/voiceover/voices error", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status },
    );
  }
}
