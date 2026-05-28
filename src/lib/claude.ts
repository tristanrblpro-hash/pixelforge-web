// Anthropic Claude wrapper. Server-only.
//
// Phase 1 will use this for smart-prompt expansion (e.g. "give me N variations
// of this prompt", brand-swap copy generation, etc.). The streaming pattern is
// already wired so longer calls don't 10-min-timeout.

import Anthropic from "@anthropic-ai/sdk";

export const MODEL_HAIKU = "claude-haiku-4-5";
export const MODEL_SONNET = "claude-sonnet-4-6";
export const MODEL_OPUS = "claude-opus-4-7";

export const PRICING_PER_MTOK: Record<string, { in: number; out: number }> = {
  [MODEL_HAIKU]:  { in: 1.0,  out: 5.0 },
  [MODEL_SONNET]: { in: 3.0,  out: 15.0 },
  [MODEL_OPUS]:   { in: 15.0, out: 75.0 },
};

const TRANSIENT = ["529", "overloaded", "503", "502", "504", "connection", "timeout", "service unavailable"];
const BACKOFF_S = [8, 16, 30, 60];

export function makeClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set on the server.");
  return new Anthropic({ apiKey: key });
}

export function estimateCost(model: string, inTok: number, outTok: number): number {
  const rate = PRICING_PER_MTOK[model] || PRICING_PER_MTOK[MODEL_OPUS];
  return (inTok * rate.in + outTok * rate.out) / 1_000_000;
}

export type ClaudeCallOptions = {
  model: string;
  system: string;
  userContent: string;
  maxTokens?: number;
  temperature?: number;
  maxRetries?: number;
};

export type ClaudeCallResult = {
  text: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  model: string;
};

export async function claudeCall(opts: ClaudeCallOptions): Promise<ClaudeCallResult> {
  const client = makeClient();
  const maxRetries = opts.maxRetries ?? 4;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const parts: string[] = [];
      const stream = client.messages.stream({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 8000,
        temperature: opts.temperature ?? 0.2,
        system: opts.system,
        messages: [{ role: "user", content: opts.userContent }],
      });
      for await (const chunk of stream) {
        if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
          parts.push(chunk.delta.text);
        }
      }
      const final = await stream.finalMessage();
      const inTok = final.usage.input_tokens;
      const outTok = final.usage.output_tokens;
      return {
        text: parts.join("").trim(),
        usage: {
          inputTokens: inTok,
          outputTokens: outTok,
          costUsd: Number(estimateCost(opts.model, inTok, outTok).toFixed(6)),
        },
        model: opts.model,
      };
    } catch (e) {
      lastErr = e;
      const msg = String(e).toLowerCase();
      const isTransient = TRANSIENT.some((k) => msg.includes(k));
      if (attempt < maxRetries - 1 && isTransient) {
        await new Promise((r) => setTimeout(r, BACKOFF_S[attempt] * 1000));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`claudeCall exhausted retries: ${String(lastErr)}`);
}

// Helpers for "JSON only" prompts
export function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}
