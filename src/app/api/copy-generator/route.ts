import { NextRequest, NextResponse } from "next/server";

import { claudeChat, MODEL_SONNET, type ChatMessage } from "@/lib/claude";
import {
  type BrandKey,
  type CustomBrand,
  getCopySystemPrompt,
} from "@/lib/copyBrands";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = {
  brand?: BrandKey;
  custom?: CustomBrand;
  transcript?: string;
  userNotes?: string;
  // Multi-turn iteration history (after the first generation). Empty array
  // on the first call — the API auto-injects the bootstrap user message.
  conversation?: ChatMessage[];
};

const VALID_BRANDS: BrandKey[] = ["orena-fr", "orena-us-men", "custom"];

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const brand = body.brand;
  if (!brand || !VALID_BRANDS.includes(brand)) {
    return NextResponse.json(
      { error: `brand must be one of ${VALID_BRANDS.join(", ")}` },
      { status: 400 },
    );
  }

  if (brand === "custom") {
    if (!body.custom?.name || !body.custom?.productDescription) {
      return NextResponse.json(
        { error: "custom brand needs at least name + productDescription" },
        { status: 400 },
      );
    }
  }

  const transcript = (body.transcript || "").trim();
  if (!transcript) {
    return NextResponse.json(
      { error: "transcript is required (paste the script or run Transcribe first)" },
      { status: 400 },
    );
  }

  // Build the bootstrap user message — what the user effectively says on the
  // first turn. This is implicit: we never store it client-side.
  const bootstrap: ChatMessage = {
    role: "user",
    content:
      "Génère les 3 ad copies + 3 titres à partir du transcript ci-dessus, en respectant strictement le format demandé.",
  };

  // Sanitize incoming conversation (follow-up turns).
  const cleaned: ChatMessage[] = Array.isArray(body.conversation)
    ? body.conversation
        .filter(
          (m) =>
            m &&
            typeof m.content === "string" &&
            m.content.trim().length > 0 &&
            (m.role === "user" || m.role === "assistant"),
        )
        .map((m) => ({
          role: m.role,
          content: m.content.slice(0, 8000),
        }))
        .slice(-20)
    : [];

  // The full message array: bootstrap first, then any iteration history.
  const messages: ChatMessage[] = [bootstrap, ...cleaned];

  try {
    const system = getCopySystemPrompt({
      brand,
      custom: body.custom,
      transcript,
      userNotes: body.userNotes,
    });
    const result = await claudeChat({
      model: MODEL_SONNET,
      system,
      messages,
      // Long enough to never truncate the titles even after 3 long copies.
      maxTokens: 4500,
      // Balance: high enough for angle variety across copies, low enough
      // for Claude to follow the strict marker format.
      temperature: 0.75,
    });
    return NextResponse.json({
      role: "assistant",
      content: result.text,
      usage: result.usage,
      model: result.model,
    });
  } catch (e) {
    console.error("/api/copy-generator error", e);
    return NextResponse.json(
      { error: String(e).slice(0, 500) },
      { status: 502 },
    );
  }
}
