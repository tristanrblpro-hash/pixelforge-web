import { NextRequest, NextResponse } from "next/server";

import { DRIVE_OAUTH_SCOPE } from "@/lib/drive";

export const dynamic = "force-dynamic";

// Initiates the Google OAuth consent flow. The user lands on Google's
// approval screen; after consenting they're redirected to
// /api/drive/oauth/callback which extracts the refresh token.
//
// This is a one-time setup endpoint — the user visits it once via their
// browser after configuring GOOGLE_OAUTH_CLIENT_ID + _CLIENT_SECRET.

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return new NextResponse(
      `<!doctype html>
       <html><body style="font-family:-apple-system,sans-serif;max-width:640px;margin:40px auto;padding:20px">
       <h1>⚠ Setup incomplete</h1>
       <p><code>GOOGLE_OAUTH_CLIENT_ID</code> is not set in Vercel.</p>
       <p>Create an OAuth Client (Web app) in Google Cloud Console, then paste:
         <ul>
           <li><code>GOOGLE_OAUTH_CLIENT_ID</code></li>
           <li><code>GOOGLE_OAUTH_CLIENT_SECRET</code></li>
         </ul>
         in Vercel → Settings → Environment Variables, redeploy, and reload this page.
       </p>
       </body></html>`,
      { headers: { "Content-Type": "text/html" }, status: 500 },
    );
  }

  const url = new URL(req.url);
  const redirectUri = `${url.origin}/api/drive/oauth/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DRIVE_OAUTH_SCOPE,
    // 'offline' is required to receive a refresh_token. 'prompt=consent'
    // forces Google to re-issue a refresh_token even if the user previously
    // approved (otherwise Google may return only an access_token).
    access_type: "offline",
    prompt: "consent",
  });

  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  );
}
