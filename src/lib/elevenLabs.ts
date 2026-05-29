// ElevenLabs REST client. Server-only.
//
// Reads the API key from process.env.ELEVENLABS_API_KEY at call time so the
// build doesn't bake it in and so a missing key fails loudly with a typed
// error instead of producing 401 garbage from the upstream API.

const API_BASE = "https://api.elevenlabs.io";

export class ElevenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElevenError";
  }
}
export class ElevenAuthError extends ElevenError {
  constructor(message: string) {
    super(message);
    this.name = "ElevenAuthError";
  }
}
export class ElevenNoCreditsError extends ElevenError {
  constructor(message: string) {
    super(message);
    this.name = "ElevenNoCreditsError";
  }
}

function requireKey(): string {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) {
    throw new ElevenAuthError(
      "ELEVENLABS_API_KEY env var is not set on the server.",
    );
  }
  return k;
}

function authHeader() {
  return { "xi-api-key": requireKey() };
}

async function handleJsonResponse(r: Response): Promise<Record<string, unknown>> {
  if (r.status === 401 || r.status === 403) {
    throw new ElevenAuthError(`ElevenLabs auth failed (HTTP ${r.status}).`);
  }
  const bodyText = await r.text();
  const lower = bodyText.toLowerCase();
  if (
    r.status === 402 ||
    lower.includes("quota_exceeded") ||
    lower.includes("insufficient_quota")
  ) {
    throw new ElevenNoCreditsError(
      "ElevenLabs is out of character credits — top up at https://elevenlabs.io/app/subscription.",
    );
  }
  if (!r.ok) {
    throw new ElevenError(`ElevenLabs HTTP ${r.status}: ${bodyText.slice(0, 400)}`);
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new ElevenError(`ElevenLabs returned non-JSON: ${bodyText.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

export type ElevenVoice = {
  voiceId: string;
  name: string;
  category?: string; // "premade" | "cloned" | "professional" | "generated"
  description?: string;
  labels?: Record<string, string>;
  previewUrl?: string;
};

export async function listVoices(): Promise<ElevenVoice[]> {
  const r = await fetch(`${API_BASE}/v1/voices`, {
    headers: authHeader(),
    cache: "no-store",
  });
  const data = await handleJsonResponse(r);
  const voices = Array.isArray(data.voices) ? (data.voices as Array<Record<string, unknown>>) : [];
  return voices.map((v) => ({
    voiceId: String(v.voice_id || ""),
    name: String(v.name || "Unnamed"),
    category: typeof v.category === "string" ? v.category : undefined,
    description: typeof v.description === "string" ? v.description : undefined,
    labels: v.labels && typeof v.labels === "object" ? (v.labels as Record<string, string>) : undefined,
    previewUrl: typeof v.preview_url === "string" ? v.preview_url : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Subscription / credits (used to surface remaining characters in the UI)
// ---------------------------------------------------------------------------

export type ElevenSubscription = {
  tier?: string;
  characterCount: number;
  characterLimit: number;
  charactersRemaining: number;
  nextResetUnix?: number;
};

export async function getSubscription(): Promise<ElevenSubscription> {
  const r = await fetch(`${API_BASE}/v1/user/subscription`, {
    headers: authHeader(),
    cache: "no-store",
  });
  const data = await handleJsonResponse(r);
  const used = Number(data.character_count ?? 0);
  const limit = Number(data.character_limit ?? 0);
  return {
    tier: typeof data.tier === "string" ? data.tier : undefined,
    characterCount: used,
    characterLimit: limit,
    charactersRemaining: Math.max(0, limit - used),
    nextResetUnix:
      typeof data.next_character_count_reset_unix === "number"
        ? data.next_character_count_reset_unix
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Text-to-speech
// ---------------------------------------------------------------------------

export type VoiceSettings = {
  stability?: number;       // 0..1
  similarityBoost?: number; // 0..1
  style?: number;           // 0..1
  useSpeakerBoost?: boolean;
};

export type TtsOptions = {
  voiceId: string;
  text: string;
  modelId?: string;       // default eleven_v3
  voiceSettings?: VoiceSettings;
  outputFormat?: string;  // mp3_44100_128 (default), pcm_16000, etc.
  // Context for stitched / chunked output. ElevenLabs uses these to keep
  // prosody (pace, intonation) consistent across chunk seams.
  previousText?: string;
  nextText?: string;
};

export async function textToSpeech(
  opts: TtsOptions,
): Promise<{ audio: ArrayBuffer; contentType: string }> {
  const url = `${API_BASE}/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}${
    opts.outputFormat ? `?output_format=${encodeURIComponent(opts.outputFormat)}` : ""
  }`;
  const isV3 = (opts.modelId || "").startsWith("eleven_v3");
  const body: Record<string, unknown> = {
    text: opts.text,
    // Multilingual v2 is the default — it supports previous_text/next_text
    // (which V3 currently rejects with a 400 'unsupported_model' error
    // from ElevenLabs) and fits comfortably under Vercel's 60s Hobby cap.
    model_id: opts.modelId || "eleven_multilingual_v2",
  };
  // Prosody-continuity hints only for models that accept them. V3 returns
  // HTTP 400 if previous_text/next_text are present.
  if (opts.previousText && !isV3) body.previous_text = opts.previousText.slice(-1000);
  if (opts.nextText && !isV3) body.next_text = opts.nextText.slice(0, 1000);
  const vs = opts.voiceSettings;
  if (vs) {
    body.voice_settings = {
      stability: vs.stability ?? 0.5,
      similarity_boost: vs.similarityBoost ?? 0.75,
      style: vs.style ?? 0,
      use_speaker_boost: vs.useSpeakerBoost ?? true,
    };
  }

  const r = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeader(),
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify(body),
  });

  if (r.status === 401 || r.status === 403) {
    throw new ElevenAuthError(`ElevenLabs auth failed (HTTP ${r.status}).`);
  }
  if (r.status === 402) {
    throw new ElevenNoCreditsError(
      "ElevenLabs is out of character credits — top up at https://elevenlabs.io/app/subscription.",
    );
  }
  if (!r.ok) {
    const errText = await r.text();
    if (errText.toLowerCase().includes("quota_exceeded")) {
      throw new ElevenNoCreditsError(
        "ElevenLabs is out of character credits — top up at https://elevenlabs.io/app/subscription.",
      );
    }
    throw new ElevenError(`ElevenLabs HTTP ${r.status}: ${errText.slice(0, 400)}`);
  }

  const contentType = r.headers.get("content-type") || "audio/mpeg";
  const audio = await r.arrayBuffer();
  return { audio, contentType };
}

// Curated model list surfaced to the UI. V3 is intentionally absent for
// now: ElevenLabs returns HTTP 400 'unsupported_model' on V3 whenever
// previous_text / next_text are included in the request, which breaks
// our chunked-generation path. We'll re-enable V3 the day ElevenLabs
// supports the context fields on it.
export const ELEVEN_MODELS = [
  {
    id: "eleven_multilingual_v2",
    label: "Multilingual v2",
    note: "Recommandé. Stable, FR + EN, auto-chunké pour les longs scripts.",
  },
  {
    id: "eleven_turbo_v2_5",
    label: "Turbo v2.5",
    note: "Plus rapide, qualité ~équivalente. Drafts.",
  },
  {
    id: "eleven_flash_v2_5",
    label: "Flash v2.5",
    note: "Ultra rapide et moins cher. Tests, itérations.",
  },
] as const;

// ---------------------------------------------------------------------------
// Text chunking helper — used by the /api/voiceover/generate route to split
// long scripts so each ElevenLabs call fits under the Vercel Hobby 60s cap.
//
// Strategy:
//   1. Split on paragraph breaks (\n\n) first.
//   2. Greedily merge paragraphs up to maxChars.
//   3. If a single paragraph is still too long, split on sentence
//      boundaries (`. ! ?` followed by whitespace + capital).
//   4. Final fallback: split on whitespace (very rare).
//
// V3 generates ~25-35ms of wall-clock per character, so a 1000-char chunk
// runs in ~25-35s — comfortably under the 60s cap.
// ---------------------------------------------------------------------------
export function splitForTts(text: string, maxChars = 1000): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return [trimmed];

  // Pass 1 — paragraph greedy merge.
  const paragraphs = trimmed.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const pass1: string[] = [];
  let buf = "";
  for (const p of paragraphs) {
    const joined = buf ? `${buf}\n\n${p}` : p;
    if (joined.length > maxChars && buf) {
      pass1.push(buf);
      buf = p;
    } else {
      buf = joined;
    }
  }
  if (buf) pass1.push(buf);

  // Pass 2 — sentence split for any chunk still over budget.
  const pass2: string[] = [];
  for (const chunk of pass1) {
    if (chunk.length <= maxChars) {
      pass2.push(chunk);
      continue;
    }
    // Sentence boundary: ., !, ? followed by whitespace and (capital | quote | digit).
    const sentences = chunk.split(/(?<=[.!?])\s+(?=["'“]?[A-ZÀ-Ý0-9])/);
    let sbuf = "";
    for (const s of sentences) {
      const joined = sbuf ? `${sbuf} ${s}` : s;
      if (joined.length > maxChars && sbuf) {
        pass2.push(sbuf);
        sbuf = s;
      } else {
        sbuf = joined;
      }
    }
    if (sbuf) pass2.push(sbuf);
  }

  // Pass 3 — word-level chop for the very rare paragraph-with-no-sentences case.
  const pass3: string[] = [];
  for (const chunk of pass2) {
    if (chunk.length <= maxChars) {
      pass3.push(chunk);
      continue;
    }
    const words = chunk.split(/\s+/);
    let wbuf = "";
    for (const w of words) {
      const joined = wbuf ? `${wbuf} ${w}` : w;
      if (joined.length > maxChars && wbuf) {
        pass3.push(wbuf);
        wbuf = w;
      } else {
        wbuf = joined;
      }
    }
    if (wbuf) pass3.push(wbuf);
  }

  return pass3;
}

export type ElevenModelId = (typeof ELEVEN_MODELS)[number]["id"];
