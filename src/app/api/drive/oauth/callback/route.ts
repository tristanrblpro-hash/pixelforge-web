import { NextRequest, NextResponse } from "next/server";

import { exchangeOAuthCode } from "@/lib/drive";

export const dynamic = "force-dynamic";

// Google sends the user back here with ?code=... after they approve the
// consent screen. We swap the code for a refresh token and display it on
// a simple HTML page so the user can copy it into Vercel as
// GOOGLE_OAUTH_REFRESH_TOKEN.

function html(body: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html>
     <html>
       <head>
         <meta charset="utf-8">
         <title>PixelForge — Drive OAuth</title>
         <style>
           body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
                  max-width: 720px; margin: 60px auto; padding: 0 20px; color: #1a1a1a;
                  background: #fafafa; line-height: 1.55; }
           h1 { font-size: 22px; margin-bottom: 8px; }
           h1.ok { color: #2a8a3a; }
           h1.err { color: #c22; }
           code, pre { font-family: 'SF Mono', Menlo, monospace; }
           pre { background: #efefef; padding: 16px; border-radius: 8px;
                 word-break: break-all; white-space: pre-wrap; font-size: 13px;
                 border: 1px solid #ddd; user-select: all; }
           ol { padding-left: 22px; }
           ol li { margin: 8px 0; }
           .copy-hint { font-size: 12px; color: #666; }
         </style>
       </head>
       <body>${body}</body>
     </html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" }, status },
  );
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return html(
      `<h1 class="err">⚠ Google returned an error</h1>
       <p><code>${error}</code></p>
       <p>Re-run the flow at <a href="/api/drive/oauth/start">/api/drive/oauth/start</a>.</p>`,
      400,
    );
  }
  if (!code) {
    return html(
      `<h1 class="err">⚠ Missing 'code' parameter</h1>
       <p>This page is only meant to be reached via the Google consent screen redirect.</p>
       <p>Start at <a href="/api/drive/oauth/start">/api/drive/oauth/start</a>.</p>`,
      400,
    );
  }

  const redirectUri = `${url.origin}/api/drive/oauth/callback`;

  try {
    const { refreshToken } = await exchangeOAuthCode(code, redirectUri);
    return html(
      `<h1 class="ok">✓ OAuth authorized</h1>
       <p>Copy this refresh token and paste it in Vercel as
       <code>GOOGLE_OAUTH_REFRESH_TOKEN</code>:</p>
       <pre>${refreshToken}</pre>
       <p class="copy-hint">Click the box, Cmd+A, Cmd+C.</p>
       <ol>
         <li>Vercel → Settings → Environment Variables → Add</li>
         <li>Key <code>GOOGLE_OAUTH_REFRESH_TOKEN</code>, paste the value above, save.</li>
         <li>Deployments → … → Redeploy (decoche le cache).</li>
         <li>Go back to PixelForge → Final → Re-sync.</li>
       </ol>
       <hr>
       <p style="color:#666;font-size:12px">
         Ce refresh token donne à PixelForge un accès continu à ton Drive
         (upload only — pas de lecture des autres fichiers). Garde-le secret.
         Tu peux le révoquer à tout moment sur
         <a href="https://myaccount.google.com/permissions" target="_blank">
           myaccount.google.com/permissions
         </a>.
       </p>`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return html(
      `<h1 class="err">⚠ Code exchange failed</h1>
       <pre>${msg}</pre>
       <p>Common fixes:
         <ul>
           <li>Le redirect URI <code>${redirectUri}</code> doit être dans la
               liste des "Authorized redirect URIs" de ton OAuth Client GCP.</li>
           <li>Si Google n'a pas renvoyé de refresh_token : révoque l'accès sur
               <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>
               et refais la flow.</li>
         </ul>
       </p>
       <p><a href="/api/drive/oauth/start">Retry</a></p>`,
      500,
    );
  }
}
