// Transcription model registry for the PixelForge "Transcribe" tool.
//
// KIE.ai hosts speech-to-text engines through the same /api/v1/jobs/createTask
// flow as the rest of the platform. We default to ElevenLabs Scribe v1
// because it's the most accurate one available for noisy/accented audio.
//
// If the active model id ever 404s or returns "model not found", check
// https://kie.ai/models for the current identifier and update the constants
// below — no other file needs to change.

export type TranscribeModel = {
  label: string;
  vendor: string;
  kieModel: string;
  // input field name on the KIE side
  audioInputKey: "audio_url" | "url" | "media_url";
  // approximate cost per minute of audio (USD), used for UI estimates
  pricePerMinute: number;
  supportsVideo: boolean;
  notes: string;
};

export const TRANSCRIBE_MODELS: Record<string, TranscribeModel> = {
  "elevenlabs-scribe": {
    label: "ElevenLabs Scribe v1",
    vendor: "ElevenLabs",
    kieModel: "elevenlabs/scribe-v1",
    audioInputKey: "audio_url",
    pricePerMinute: 0.022,
    supportsVideo: true,
    notes: "Best-in-class transcription, handles accents and noisy backgrounds.",
  },
  "whisper-large-v3": {
    label: "Whisper Large v3 Turbo",
    vendor: "OpenAI / Replicate",
    kieModel: "openai/whisper-large-v3-turbo",
    audioInputKey: "audio_url",
    pricePerMinute: 0.006,
    supportsVideo: true,
    notes: "Fast and cheap. Slightly less accurate on accented speech.",
  },
};

export const DEFAULT_TRANSCRIBE_MODEL = "elevenlabs-scribe";

// Pull the transcript text out of a KIE record. KIE wraps results in many
// different shapes (resultJson string, resultJson object, direct fields), so
// we probe several common keys.
export function extractTranscriptText(record: Record<string, unknown>): string | null {
  // 1. resultJson as a JSON string (most common).
  let parsed: Record<string, unknown> = {};
  const rj = record.resultJson;
  if (typeof rj === "string" && rj) {
    try {
      parsed = JSON.parse(rj);
    } catch {
      parsed = {};
    }
  } else if (rj && typeof rj === "object") {
    parsed = rj as Record<string, unknown>;
  }

  const candidates: Array<Record<string, unknown> | undefined> = [
    parsed,
    record,
    (record.response as Record<string, unknown>) || undefined,
    (parsed.response as Record<string, unknown>) || undefined,
  ];

  for (const c of candidates) {
    if (!c) continue;
    for (const key of ["text", "transcript", "transcription", "output", "result"]) {
      const v = c[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    // Some models return [{text: "..."}, ...] segments
    const segs = c.segments;
    if (Array.isArray(segs)) {
      const joined = segs
        .map((s) => (typeof s === "object" && s && "text" in s ? String((s as { text: unknown }).text) : ""))
        .filter(Boolean)
        .join(" ")
        .trim();
      if (joined) return joined;
    }
  }
  return null;
}
