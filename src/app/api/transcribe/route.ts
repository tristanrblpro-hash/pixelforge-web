import { NextRequest, NextResponse } from "next/server";

import { fetchTask, normalizeState, rehostToKie, submitTask } from "@/lib/kie";
import {
  DEFAULT_TRANSCRIBE_MODEL,
  TRANSCRIBE_MODELS,
  extractTranscriptText,
} from "@/lib/transcribeModels";

export const dynamic = "force-dynamic";
// Long videos can take a while. Cap at 60s — clients should poll for
// anything longer, but most voice-over clips finish well under this.
export const maxDuration = 60;

type Body = {
  mediaUrl?: string;
  modelKey?: string;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const mediaUrl = (body.mediaUrl || "").trim();
  if (!mediaUrl) {
    return NextResponse.json({ error: "mediaUrl is required" }, { status: 400 });
  }

  const modelKey = body.modelKey || DEFAULT_TRANSCRIBE_MODEL;
  const model = TRANSCRIBE_MODELS[modelKey];
  if (!model) {
    return NextResponse.json(
      { error: `Unknown transcription model: ${modelKey}` },
      { status: 400 },
    );
  }

  try {
    // KIE accepts public URLs from its own whitelist (kieai.redpandaai.co /
    // tempfile.redpandaai.co). Re-host the user's Supabase URL there before
    // submitting so the engine can actually fetch the bytes.
    //
    // rehostToKie's image path runs the file through sharp; for audio/video
    // it passes through. To force the passthrough branch we strip the path
    // logic by setting a generic upload folder.
    const kieMediaUrl = await rehostToKie(mediaUrl, "transcribe-media");

    const input: Record<string, unknown> = {};
    input[model.audioInputKey] = kieMediaUrl;

    const taskId = await submitTask(model.kieModel, input);

    // Poll inline. Most voice-overs finish in 5-20s.
    const deadline = Date.now() + 55_000;
    let lastRecord: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      const record = await fetchTask(taskId);
      lastRecord = record;
      const state = normalizeState(record);
      if (state === "success") {
        const text = extractTranscriptText(record);
        if (!text) {
          return NextResponse.json(
            {
              error: "Transcription returned no text",
              raw: JSON.stringify(record).slice(0, 1000),
            },
            { status: 502 },
          );
        }
        return NextResponse.json({
          task_id: taskId,
          model: model.label,
          text,
        });
      }
      if (state === "fail") {
        const err =
          (record.failMsg as string) ||
          (record.error as string) ||
          (record.errorMessage as string) ||
          "unknown error";
        const code = (record.failCode as string) || "";
        return NextResponse.json(
          { error: code ? `[${code}] ${err}` : String(err), task_id: taskId },
          { status: 502 },
        );
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Timed out — return the task id so the client could poll separately
    // (not implemented yet because real voice-overs almost always finish
    // under 55s on Scribe/Whisper).
    return NextResponse.json(
      {
        error: "Transcription timed out after 55s — try a shorter clip.",
        task_id: taskId,
        last_state: normalizeState(lastRecord),
      },
      { status: 504 },
    );
  } catch (e) {
    console.error("/api/transcribe error", e);
    return NextResponse.json(
      { error: String(e).slice(0, 500) },
      { status: 502 },
    );
  }
}
