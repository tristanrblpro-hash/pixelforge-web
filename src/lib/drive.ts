// Google Drive REST client. Server-only.
//
// Auth strategy: OAuth refresh-token flow. The Service Account approach
// is intentionally NOT used because Service Accounts have no storage quota
// in personal Google Drives — uploads always fail with HTTP 403 'Service
// Accounts do not have storage quota'. OAuth lets us upload AS THE USER,
// so files use the user's own 100 GB / 200 GB / etc. quota.
//
// One-time setup flow (via the /api/drive/oauth/start endpoint):
//   1. User creates an OAuth Client (Web app type) in Google Cloud Console.
//   2. User pastes GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET into
//      Vercel env vars.
//   3. User visits /api/drive/oauth/start → consent screen → callback.
//   4. Callback page displays a refresh_token. User pastes it as
//      GOOGLE_OAUTH_REFRESH_TOKEN in Vercel + redeploys.
//
// After setup, the server caches access tokens (~1h lifetime) and refreshes
// them on demand.
//
// We deliberately skip the `googleapis` SDK to keep deps tiny.

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
export const DRIVE_OAUTH_SCOPE = SCOPE;

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class DriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveError";
  }
}
export class DriveAuthError extends DriveError {
  constructor(message: string) {
    super(message);
    this.name = "DriveAuthError";
  }
}

// ---------------------------------------------------------------------------
// Access token via OAuth refresh token. Cached for ~1 hour.
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new DriveAuthError(
      "OAuth credentials missing. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN in Vercel. Run the /api/drive/oauth/start flow once to obtain the refresh token.",
    );
  }

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new DriveAuthError(
      `Token refresh failed: HTTP ${r.status} — ${text.slice(0, 200)}. Le refresh token est peut-être révoqué — refais /api/drive/oauth/start.`,
    );
  }
  const data = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new DriveAuthError("Token response missing access_token");
  }
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
  };
  return data.access_token;
}

// Exposed for the OAuth callback route to exchange an auth code for a
// refresh token + access token pair.
export async function exchangeOAuthCode(
  code: string,
  redirectUri: string,
): Promise<{ refreshToken: string; accessToken: string; expiresIn: number }> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new DriveAuthError(
      "OAuth client credentials missing: set GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET first.",
    );
  }
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new DriveAuthError(`Code exchange failed: HTTP ${r.status} — ${text.slice(0, 200)}`);
  }
  const data = (await r.json()) as {
    refresh_token?: string;
    access_token?: string;
    expires_in?: number;
  };
  if (!data.refresh_token) {
    throw new DriveAuthError(
      "Google did not return a refresh_token. Most likely cause: you've already granted PixelForge access before. Go to https://myaccount.google.com/permissions, remove PixelForge, then re-run the OAuth flow.",
    );
  }
  if (!data.access_token) {
    throw new DriveAuthError("Code exchange returned no access_token");
  }
  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 3600,
  };
}

// ---------------------------------------------------------------------------
// Folder management — find or create a sub-folder by name under a parent.
// Used by the Notion sync to organise media per hook (1 folder = 1 video
// variation) instead of dumping every file at the root.
// ---------------------------------------------------------------------------

export async function findOrCreateFolder(parentId: string, name: string): Promise<string> {
  const token = await getAccessToken();
  // Drive's q-param needs single quotes escaped.
  const safeName = name.replace(/'/g, "\\'");
  const q =
    `name = '${safeName}' and '${parentId}' in parents and ` +
    `mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const searchResp = await fetch(
    `${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (searchResp.ok) {
    const data = (await searchResp.json()) as { files?: Array<{ id: string }> };
    const existing = data.files?.[0]?.id;
    if (existing) return existing;
  }
  // Create the folder.
  const createResp = await fetch(`${FILES_URL}?supportsAllDrives=true&fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      parents: [parentId],
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  if (!createResp.ok) {
    const text = await createResp.text();
    throw new DriveError(`Folder create failed: HTTP ${createResp.status} — ${text.slice(0, 200)}`);
  }
  const created = (await createResp.json()) as { id: string };

  // Make the new folder publicly readable so the monteur can navigate
  // inside via the Drive viewer without auth.
  try {
    await fetch(`${FILES_URL}/${created.id}/permissions?supportsAllDrives=true`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "anyone", role: "reader" }),
    });
  } catch {
    /* keep going — folder is still usable */
  }
  return created.id;
}

export async function getFolderWebUrl(folderId: string): Promise<string> {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

// Look up a file by name inside a folder. Returns null if missing.
export async function findFileInFolder(
  folderId: string,
  name: string,
): Promise<DriveUploadResult | null> {
  const token = await getAccessToken();
  const safeName = name.replace(/'/g, "\\'");
  const q = `name = '${safeName}' and '${folderId}' in parents and trashed = false`;
  const r = await fetch(
    `${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink,webContentLink)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) return null;
  const data = (await r.json()) as { files?: DriveUploadResult[] };
  return data.files?.[0] || null;
}

// Lazy-cache: if the named file already exists in the folder, return it
// untouched. Otherwise download from sourceUrl and upload. Used for static
// shared assets like background music tracks.
export async function findOrUploadFromUrl(
  folderId: string,
  name: string,
  sourceUrl: string,
  mimeType: string,
): Promise<DriveUploadResult> {
  const existing = await findFileInFolder(folderId, name);
  if (existing && existing.webViewLink) return existing;
  return uploadUrlToFolder(folderId, sourceUrl, name, mimeType);
}

// ---------------------------------------------------------------------------
// File upload — multipart with metadata. Returns the webViewLink (open in
// Drive UI) and the file id.
// ---------------------------------------------------------------------------

export type DriveUploadResult = {
  id: string;
  name: string;
  webViewLink: string;
  webContentLink?: string;
};

export async function uploadFileToFolder(
  folderId: string,
  fileName: string,
  mimeType: string,
  body: ArrayBuffer | Buffer,
): Promise<DriveUploadResult> {
  if (!folderId) {
    throw new DriveError("uploadFileToFolder called without a folderId");
  }
  const token = await getAccessToken();

  const metadata = {
    name: fileName,
    parents: [folderId],
    mimeType,
  };

  // Multipart/related body — RFC 2387.
  const boundary = "pf" + Math.random().toString(36).slice(2, 14);
  const parts: Buffer[] = [];
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    ),
  );
  parts.push(Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`));
  parts.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
  parts.push(Buffer.from(`\r\n--${boundary}--`));
  const multipart = Buffer.concat(parts);

  const r = await fetch(
    `${UPLOAD_URL}?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,webContentLink`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: multipart,
    },
  );
  if (!r.ok) {
    const text = await r.text();
    throw new DriveError(`Upload failed: HTTP ${r.status} — ${text.slice(0, 400)}`);
  }
  const data = (await r.json()) as DriveUploadResult;

  // Make the file publicly readable so monteur can download via link
  // without auth. Best-effort — if this fails the upload still succeeded.
  try {
    await fetch(`${FILES_URL}/${data.id}/permissions?supportsAllDrives=true`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "anyone", role: "reader" }),
    });
  } catch {
    /* keep going */
  }

  return data;
}

// Convenience: download a public URL (e.g. Supabase Storage) on the server,
// then upload the bytes to Drive. Keeps the file body out of the browser →
// Vercel request body cap doesn't apply.
export async function uploadUrlToFolder(
  folderId: string,
  sourceUrl: string,
  fileName: string,
  mimeTypeHint?: string,
): Promise<DriveUploadResult> {
  const fetched = await fetch(sourceUrl);
  if (!fetched.ok) {
    throw new DriveError(`Failed to fetch source ${sourceUrl}: HTTP ${fetched.status}`);
  }
  const mimeType =
    mimeTypeHint || fetched.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await fetched.arrayBuffer());
  return uploadFileToFolder(folderId, fileName, mimeType, buf);
}
