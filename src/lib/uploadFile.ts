// Tiny helper used by every "upload a file then attach it somewhere"
// flow (avatar image / VO clip, generic AttachToBriefButton, etc.).
//
// /api/upload is supposed to always return JSON, but Vercel's edge can
// inject an HTML error page in certain cases (payload too large past
// the body-size cap, gateway timeout, request rejected before reaching
// the function, etc.). Calling `r.json()` on that response throws an
// opaque "Failed to execute 'json' on 'Response'" — useless to the user.
//
// This helper:
//   1. Reads the body as text once (so we don't double-read).
//   2. Tries to JSON.parse it. On parse failure, surfaces an error that
//      includes the HTTP status AND a snippet of the body (HTML tags
//      stripped) so the user sees something actionable.
//   3. Returns the public URL on success, throws a typed Error otherwise.

export async function uploadFileToStorage(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch("/api/upload", { method: "POST", body: form });
  const bodyText = await r.text();

  let data: { url?: string; error?: string } = {};
  if (bodyText) {
    try {
      data = JSON.parse(bodyText) as typeof data;
    } catch {
      // Body was not JSON — almost certainly an HTML error page from
      // Vercel's edge (payload too large, gateway, etc.).
      const cleaned = bodyText
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      throw new Error(
        `Upload échoué (HTTP ${r.status})${cleaned ? ` — ${cleaned.slice(0, 200)}` : ""}`,
      );
    }
  }

  if (!r.ok || !data.url) {
    throw new Error(data.error || `Upload échoué (HTTP ${r.status})`);
  }
  return data.url;
}
