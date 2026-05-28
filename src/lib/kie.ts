// KIE.ai REST client (TypeScript port of kie_client.py).
// Server-only. Reads the API key from process.env.KIE_API_KEY at call time.

const API_BASE = "https://api.kie.ai";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class KieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KieError";
  }
}
export class KieAuthError extends KieError {
  constructor(message: string) {
    super(message);
    this.name = "KieAuthError";
  }
}
export class KieNoCreditsError extends KieError {
  constructor(message: string) {
    super(message);
    this.name = "KieNoCreditsError";
  }
}
export class KieTaskFailed extends KieError {
  constructor(message: string) {
    super(message);
    this.name = "KieTaskFailed";
  }
}

function requireKey(): string {
  const k = process.env.KIE_API_KEY;
  if (!k) throw new KieAuthError("KIE_API_KEY env var is not set on the server.");
  return k;
}

function authHeader() {
  return { Authorization: `Bearer ${requireKey()}` };
}

async function handleResponse(r: Response): Promise<Record<string, unknown>> {
  if (r.status === 401 || r.status === 403) {
    throw new KieAuthError(
      `KIE.ai authentication failed (HTTP ${r.status}). Check the API key.`,
    );
  }
  const bodyText = await r.text();
  const lower = bodyText.toLowerCase();
  if (r.status === 402 || lower.includes("insufficient credits") || lower.includes("no credits")) {
    throw new KieNoCreditsError("KIE.ai is out of credits. Top up at https://kie.ai/billing.");
  }
  if (!r.ok) {
    throw new KieError(`KIE.ai HTTP ${r.status}: ${bodyText.slice(0, 400)}`);
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new KieError(`KIE.ai returned non-JSON: ${bodyText.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Submit / poll
// ---------------------------------------------------------------------------

export type SubmitOptions = {
  useVeoEndpoint?: boolean;
};

export async function submitTask(
  model: string,
  inputs: Record<string, unknown>,
  opts: SubmitOptions = {},
): Promise<string> {
  const url = opts.useVeoEndpoint
    ? `${API_BASE}/api/v1/veo/generate`
    : `${API_BASE}/api/v1/jobs/createTask`;
  const payload = opts.useVeoEndpoint ? { model, ...inputs } : { model, input: inputs };

  const r = await fetch(url, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await handleResponse(r);
  const taskId =
    (data.data as { taskId?: string } | undefined)?.taskId ?? (data.taskId as string | undefined);
  if (!taskId) throw new KieError(`No taskId in KIE response: ${JSON.stringify(data).slice(0, 300)}`);
  return String(taskId);
}

export async function fetchTask(taskId: string): Promise<Record<string, unknown>> {
  const url = `${API_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`;
  const r = await fetch(url, { headers: authHeader() });
  const data = await handleResponse(r);
  return (data.data as Record<string, unknown>) || {};
}

export function normalizeState(record: Record<string, unknown>): "success" | "fail" | "processing" {
  const stateRaw = record.state;
  if (typeof stateRaw === "string") {
    const s = stateRaw.toLowerCase();
    if (["success", "completed", "succeeded"].includes(s)) return "success";
    if (["fail", "failed", "error"].includes(s)) return "fail";
    return "processing";
  }
  const flag = record.successFlag;
  if (flag === 1) return "success";
  if (flag === 2 || flag === 3) return "fail";
  return "processing";
}

export function extractResultUrls(record: Record<string, unknown>): string[] {
  const urls: string[] = [];

  // 1. resultJson as a JSON-encoded string (Kling, Sora, Topaz, gpt-image-2)
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
  for (const key of ["resultUrls", "urls", "videos", "images"]) {
    const v = parsed[key];
    if (Array.isArray(v)) urls.push(...(v as unknown[]).filter(Boolean).map(String));
    else if (typeof v === "string" && v) urls.push(v);
  }

  // 2. resultUrls directly on record (or nested in response)
  const candidates: Array<Record<string, unknown> | undefined> = [
    record,
    (record.response as Record<string, unknown>) || undefined,
  ];
  for (const container of candidates) {
    if (!container) continue;
    const res = container.resultUrls;
    if (Array.isArray(res)) urls.push(...(res as unknown[]).filter(Boolean).map(String));
    else if (typeof res === "string" && res) urls.push(res);
  }

  // 3. Single-URL shortcuts (Veo)
  for (const k of ["videoUrl", "imageUrl", "resultUrl"]) {
    const v = record[k];
    if (typeof v === "string" && v) urls.push(v);
  }

  return Array.from(new Set(urls));
}

export type WaitOptions = {
  onUpdate?: (state: string, record: Record<string, unknown>) => void;
  pollEverySec?: number;
  timeoutSec?: number;
};

export async function waitTask(
  taskId: string,
  opts: WaitOptions = {},
): Promise<Record<string, unknown>> {
  const pollMs = (opts.pollEverySec ?? 6) * 1000;
  const deadline = Date.now() + (opts.timeoutSec ?? 900) * 1000;
  // NB: serverless functions on Vercel have a max runtime — long videos should
  // be polled by the client, not from inside a single request handler.
  while (true) {
    const record = await fetchTask(taskId);
    const state = normalizeState(record);
    opts.onUpdate?.(state, record);
    if (state === "success") return record;
    if (state === "fail") {
      const err = record.error || record.errorMessage || "unknown error";
      throw new KieTaskFailed(`KIE task ${taskId} failed: ${String(err)}`);
    }
    if (Date.now() > deadline) {
      throw new KieTaskFailed(`KIE task ${taskId} timed out`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ---------------------------------------------------------------------------
// File upload (multipart). On Vercel, large files should go straight to
// Supabase Storage from the client; this helper is for server-side use cases.
// ---------------------------------------------------------------------------

export async function uploadFile(
  file: Blob,
  filename: string,
  uploadPath = "user-uploads",
): Promise<string> {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("uploadPath", uploadPath);
  const r = await fetch(`${API_BASE}/api/file-stream-upload`, {
    method: "POST",
    headers: authHeader(),
    body: form,
  });
  const data = await handleResponse(r);
  const downloadUrl =
    (data.data as { downloadUrl?: string } | undefined)?.downloadUrl ??
    (data.downloadUrl as string | undefined);
  if (!downloadUrl)
    throw new KieError(`No downloadUrl in KIE upload response: ${JSON.stringify(data).slice(0, 300)}`);
  return String(downloadUrl);
}
