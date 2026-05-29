import { NextRequest, NextResponse } from "next/server";

import { claudeChat, MODEL_SONNET, type ChatMessage } from "@/lib/claude";
import { getSystemPrompt, type PromptMode } from "@/lib/promptSystemPrompts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = {
  mode?: PromptMode;
  conversation?: ChatMessage[];
};

const VALID_MODES: PromptMode[] = ["image", "video", "lipsync"];

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const mode = body.mode;
  if (!mode || !VALID_MODES.includes(mode)) {
    return NextResponse.json(
      { error: `mode must be one of ${VALID_MODES.join(", ")}` },
      { status: 400 },
    );
  }

  const conversation = Array.isArray(body.conversation) ? body.conversation : [];
  if (conversation.length === 0) {
    return NextResponse.json(
      { error: "conversation cannot be empty" },
      { status: 400 },
    );
  }

  // Sanitize: drop empties (unless they carry images), clamp content length,
  // ensure first message is from user.
  const cleaned: ChatMessage[] = conversation
    .filter((m) => {
      if (!m) return false;
      const hasText = typeof m.content === "string" && m.content.trim().length > 0;
      const hasImages = Array.isArray(m.images) && m.images.length > 0;
      return hasText || hasImages;
    })
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content.slice(0, 8000) : "",
      images: Array.isArray(m.images)
        ? m.images.filter((u) => typeof u === "string" && u.startsWith("http")).slice(0, 8)
        : undefined,
    }));

  if (cleaned.length === 0 || cleaned[0].role !== "user") {
    return NextResponse.json(
      { error: "first message must come from the user" },
      { status: 400 },
    );
  }

  // Hard cap the rolling history at the last 20 turns to keep cost bounded.
  const trimmed = cleaned.slice(-20);

  try {
    const result = await claudeChat({
      model: MODEL_SONNET,
      system: getSystemPrompt(mode),
      messages: trimmed,
      maxTokens: 2000,
      temperature: 0.7,
    });

    return NextResponse.json({
      role: "assistant",
      content: result.text,
      usage: result.usage,
      model: result.model,
    });
  } catch (e) {
    console.error("/api/prompt-generator error", e);
    return NextResponse.json(
      { error: String(e).slice(0, 500) },
      { status: 502 },
    );
  }
}
