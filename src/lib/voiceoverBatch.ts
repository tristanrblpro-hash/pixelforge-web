// Helper to batch-generate voice-overs against /api/voiceover/generate with
// a concurrency cap. Used by BriefBatchWizard to fire 30+ generations in
// parallel without overwhelming ElevenLabs or Vercel's invocation budget.
//
// Each job calls back with status updates so the UI can render live
// per-row state without polling.

export type VoBatchJob = {
  id: string; // arbitrary client-side id (e.g. `${briefId}:${hookId}`)
  voiceId: string;
  voiceName?: string;
  text: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
};

export type VoBatchResult =
  | { id: string; ok: true; url: string; charCount: number }
  | { id: string; ok: false; error: string };

export type VoBatchEvent =
  | { id: string; kind: "start" }
  | (VoBatchResult & { kind: "end" });

const DEFAULT_CONCURRENCY = 4;

export async function runVoiceoverBatch(
  jobs: VoBatchJob[],
  onEvent: (e: VoBatchEvent) => void,
  opts?: { concurrency?: number; signal?: AbortSignal },
): Promise<VoBatchResult[]> {
  const concurrency = Math.max(1, Math.min(8, opts?.concurrency ?? DEFAULT_CONCURRENCY));
  const queue = jobs.slice();
  const results: VoBatchResult[] = [];

  async function worker() {
    while (queue.length > 0) {
      if (opts?.signal?.aborted) return;
      const job = queue.shift();
      if (!job) return;
      onEvent({ id: job.id, kind: "start" });
      try {
        const r = await fetch("/api/voiceover/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            voiceId: job.voiceId,
            voiceName: job.voiceName,
            text: job.text,
            modelId: job.modelId ?? "eleven_multilingual_v2",
            stability: job.stability,
            similarityBoost: job.similarityBoost,
            style: job.style,
            useSpeakerBoost: job.useSpeakerBoost,
          }),
          signal: opts?.signal,
        });
        const data = (await r.json()) as {
          url?: string;
          charCount?: number;
          error?: string;
        };
        if (!r.ok || !data.url) {
          const result: VoBatchResult = {
            id: job.id,
            ok: false,
            error: data.error || `HTTP ${r.status}`,
          };
          results.push(result);
          onEvent({ ...result, kind: "end" });
        } else {
          const result: VoBatchResult = {
            id: job.id,
            ok: true,
            url: data.url,
            charCount: data.charCount ?? job.text.length,
          };
          results.push(result);
          onEvent({ ...result, kind: "end" });
        }
      } catch (e) {
        const result: VoBatchResult = {
          id: job.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
        results.push(result);
        onEvent({ ...result, kind: "end" });
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}
