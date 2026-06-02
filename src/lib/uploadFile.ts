// Tiny helper used by every "upload a file then attach it somewhere"
// flow (avatar image / VO clip, generic AttachToBriefButton, etc.).
//
// Two responsibilities:
//   1. Compress images client-side BEFORE upload so we stay under
//      Vercel's body-size cap (4.5 MB on Hobby, 50 MB on Pro). Most
//      raw photos coming from a Mac / iPhone weigh 5-30 MB and would
//      hit a 413 from the edge without this. Audio + video are left
//      untouched.
//   2. Read /api/upload's response defensively — when Vercel intercepts
//      with an HTML error page (413, 504, etc.) `r.json()` throws an
//      opaque "Failed to execute 'json' on 'Response'". This helper
//      surfaces the HTTP status + a cleaned body snippet instead.

/** Skip compression for images already below this size — they upload fine
 *  as-is and re-encoding only adds a small quality loss for no benefit. */
const COMPRESSION_THRESHOLD_BYTES = 2 * 1024 * 1024;
/** Longest side after resize. 2400 px keeps 4K-ish detail for ad work
 *  while reliably staying under 2-3 MB once JPEG-compressed. */
const MAX_DIMENSION_PX = 2400;
/** JPEG quality. 0.85 is the sweet spot: indistinguishable from source
 *  on photographs, ~5× smaller than PNG. */
const JPEG_QUALITY = 0.85;

/**
 * Resize + re-encode an image to JPEG when it's bigger than the
 * threshold. Returns the original file unchanged when it's already
 * small, when it's not an image, or when canvas decoding fails (we
 * never silently break the upload — worst case we hit 413 again).
 */
async function compressImageIfLarge(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  if (file.size <= COMPRESSION_THRESHOLD_BYTES) return file;

  try {
    return await new Promise<File>((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          const scale = Math.min(
            MAX_DIMENSION_PX / img.naturalWidth,
            MAX_DIMENSION_PX / img.naturalHeight,
            1,
          );
          const w = Math.round(img.naturalWidth * scale);
          const h = Math.round(img.naturalHeight * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(file);
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob(
            (blob) => {
              if (!blob) {
                resolve(file);
                return;
              }
              const renamed = file.name.replace(/\.[^.]+$/, "") + ".jpg";
              resolve(
                new File([blob], renamed, {
                  type: "image/jpeg",
                  lastModified: file.lastModified,
                }),
              );
            },
            "image/jpeg",
            JPEG_QUALITY,
          );
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("decode failed"));
      };
      img.src = url;
    });
  } catch {
    // Compression failed for some reason — fall back to the original.
    return file;
  }
}

export async function uploadFileToStorage(file: File): Promise<string> {
  const toUpload = await compressImageIfLarge(file);
  const form = new FormData();
  form.append("file", toUpload);
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
