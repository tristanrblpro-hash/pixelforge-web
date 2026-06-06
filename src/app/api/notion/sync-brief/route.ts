import { NextRequest, NextResponse } from "next/server";

import { type Brief, type HookBrief } from "@/lib/briefs";
import { findOrCreateFolder, uploadUrlToFolder } from "@/lib/drive";
import {
  NotionAccessError,
  NotionAuthError,
  NotionBlock,
  syncPageInDatabase,
} from "@/lib/notion";

export const dynamic = "force-dynamic";
// File uploads to Drive can dominate the wall clock. Cap at 300s (Pro);
// Hobby still falls back to 60s.
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// Drive subfolder convention (matches the user's existing ORENA CONTENT
// structure under 04_SPECIFIC). GOOGLE_DRIVE_FOLDER_ID should point at
// the folder that DIRECTLY contains these two subfolders. If they're
// missing, we create them.
// ---------------------------------------------------------------------------

const SUBFOLDER_AI_AVATAR = "AI Avatar Videos";
const SUBFOLDER_VOICEOVER = "Voiceover";

// Shared Background Music folder managed manually by the user. Notion pages
// just embed this link + the two filenames in italic — no upload/lookup
// happens server-side anymore.
const BG_MUSIC_FOLDER_URL =
  "https://drive.google.com/drive/folders/1ybiZSXj-FIPY567re7DPbYg7bVOy5vLz?usp=drive_link";
const BG_MUSIC_INTRO_NAME = "Medical_news_documentary_science.mp3";
const BG_MUSIC_PAYOFF_NAME = "medical_sound.mp3";

// Shared "Content access" root folder shown in every Notion page. Static
// link to the monteur-facing root in Drive — not the upload target.
const CONTENT_ACCESS_FOLDER_URL =
  "https://drive.google.com/drive/folders/11yDo1-gKjhhJ07RHzD1qupnYderyVmbY?usp=drive_link";

type Body = { brief?: Brief };

function hookSuffix(hook: HookBrief): string {
  return hook.index === 1 ? "Hook 1 (Original)" : `Hook ${hook.index}`;
}

function hookPageTitle(brief: Brief, hook: HookBrief): string {
  return `${brief.adsetName} - ${hookSuffix(hook)}`;
}

// ---------------------------------------------------------------------------
// Notion block factories — same set as before, kept inline so the brief →
// blocks code reads top-to-bottom in this file.
// ---------------------------------------------------------------------------

const RICH_MAX = 2000;

type Annotations = {
  bold?: boolean;
  italic?: boolean;
};
type RichTextItem = {
  type: "text";
  text: { content: string; link?: { url: string } };
  annotations?: Annotations;
};

function rt(
  content: string,
  opts?: { bold?: boolean; italic?: boolean; link?: string },
): RichTextItem {
  const item: RichTextItem = {
    type: "text",
    text: { content: content.slice(0, RICH_MAX) },
  };
  if (opts?.link) item.text.link = { url: opts.link };
  if (opts?.bold || opts?.italic) {
    item.annotations = {};
    if (opts.bold) item.annotations.bold = true;
    if (opts.italic) item.annotations.italic = true;
  }
  return item;
}
function paragraphBlock(items: RichTextItem[]): NotionBlock {
  return { object: "block", type: "paragraph", paragraph: { rich_text: items } };
}
function paragraphText(content: string, opts?: { bold?: boolean; italic?: boolean }): NotionBlock {
  return paragraphBlock([rt(content, opts)]);
}
function paragraphParaSplit(content: string): NotionBlock[] {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: NotionBlock[] = [];
  for (const p of paragraphs) {
    for (let i = 0; i < p.length; i += RICH_MAX) {
      out.push(paragraphText(p.slice(i, i + RICH_MAX)));
    }
  }
  return out;
}
function heading2Block(content: string): NotionBlock {
  return { object: "block", type: "heading_2", heading_2: { rich_text: [rt(content)] } };
}
function dividerBlock(): NotionBlock {
  return { object: "block", type: "divider", divider: {} };
}
function bulletedItem(items: RichTextItem[]): NotionBlock {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: items },
  };
}
function numberedItem(items: RichTextItem[]): NotionBlock {
  return {
    object: "block",
    type: "numbered_list_item",
    numbered_list_item: { rich_text: items },
  };
}
function calloutBlock(emoji: string, items: RichTextItem[], children?: NotionBlock[]): NotionBlock {
  const callout: Record<string, unknown> = {
    rich_text: items,
    icon: { type: "emoji", emoji },
    color: "gray_background",
  };
  if (children && children.length > 0) callout.children = children;
  return { object: "block", type: "callout", callout };
}

// ---------------------------------------------------------------------------
// Drive upload pipeline
// ---------------------------------------------------------------------------

function slugCleanForFilename(s: string): string {
  // Drive only forbids / : * ? " < > | (plus line breaks). Everything else
  // stays so folder + file names remain readable for the monteur in the
  // Drive UI (matches the user's existing convention
  // "Ad Test #1 - Anti-Fake Dermato (Voice)").
  return s
    .replace(/[\/:*?"<>|\n\r\t]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

type DrivedBrief = {
  brief: Brief;
};

async function processForDrive(brief: Brief): Promise<DrivedBrief> {
  if (
    !process.env.GOOGLE_OAUTH_CLIENT_ID ||
    !process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
    !process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  ) {
    throw new Error(
      "Drive OAuth manquant côté Vercel. Visite /api/drive/oauth/start une fois pour obtenir le refresh token, puis colle-le comme GOOGLE_OAUTH_REFRESH_TOKEN dans Vercel.",
    );
  }
  if (!process.env.GOOGLE_DRIVE_FOLDER_ID) {
    throw new Error("GOOGLE_DRIVE_FOLDER_ID manquant côté Vercel.");
  }
  const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  // 1. Ensure the 2 conventional top-level subfolders exist. (Background
  //    Music is handled manually by the user and lives in a separate
  //    Drive folder linked statically from the Notion page.)
  const [aiAvatarFolderId, voiceoverFolderId] = await Promise.all([
    findOrCreateFolder(rootId, SUBFOLDER_AI_AVATAR),
    findOrCreateFolder(rootId, SUBFOLDER_VOICEOVER),
  ]);

  // 2. Per-creative subfolders inside Voiceover/ and AI Avatar Videos/,
  //    named with the user's existing convention:
  //      "<adsetName> (Voice)"      ← all 3 hook voice-overs
  //      "<adsetName> (AI Avatar)"  ← all 3 hook lipsync videos
  //    findOrCreateFolder is idempotent — if the user manually pre-
  //    created these folders, we just reuse them.
  const adsetClean = slugCleanForFilename(brief.adsetName || "brief");
  const voiceCreativeFolderName = `${adsetClean} (Voice)`;
  const avatarCreativeFolderName = `${adsetClean} (AI Avatar)`;
  const [creativeVoiceFolderId, creativeAvatarFolderId] = await Promise.all([
    findOrCreateFolder(voiceoverFolderId, voiceCreativeFolderName),
    findOrCreateFolder(aiAvatarFolderId, avatarCreativeFolderName),
  ]);

  // 3. Deep clone the brief so we never mutate the caller's input.
  const next: Brief = JSON.parse(JSON.stringify(brief)) as Brief;

  // 4. Fire all media uploads in parallel into the per-creative subfolders.
  //    File naming includes the hook label so the 3 variants are
  //    distinguishable inside the creative folder.
  const uploadJobs: Promise<void>[] = [];
  for (const hook of next.hooks) {
    const baseLabel = slugCleanForFilename(hookPageTitle(next, hook));

    if (hook.cutVoUrl) {
      const url = hook.cutVoUrl;
      uploadJobs.push(
        (async () => {
          try {
            const r = await uploadUrlToFolder(
              creativeVoiceFolderId,
              url,
              `${baseLabel} (Voice).mp3`,
              "audio/mpeg",
            );
            hook.cutVoUrl = r.webViewLink;
          } catch (e) {
            throw new Error(
              `Upload Voice failed (${baseLabel}): ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        })(),
      );
    }

    for (const av of hook.avatars) {
      if (av.lipsyncVideoUrl && av.lipsyncStatus === "done") {
        const videoUrl = av.lipsyncVideoUrl;
        const avLabel = slugCleanForFilename(av.label || "Avatar");
        const fileName = `${baseLabel} - ${avLabel} (AI Avatar).mp4`;
        uploadJobs.push(
          (async () => {
            try {
              const r = await uploadUrlToFolder(
                creativeAvatarFolderId,
                videoUrl,
                fileName,
                "video/mp4",
              );
              av.lipsyncVideoUrl = r.webViewLink;
            } catch (e) {
              throw new Error(
                `Upload AI Avatar Video failed (${fileName}): ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          })(),
        );
      }
    }
  }
  await Promise.all(uploadJobs);

  return { brief: next };
}

// ---------------------------------------------------------------------------
// buildHookPage — emits Notion blocks for ONE hook, matching the user's
// existing template (Ad Creative format).
// ---------------------------------------------------------------------------

function buildHookPage(brief: Brief, hook: HookBrief): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const adId = hookPageTitle(brief, hook);

  // 1. 🎁 PERFORMANCE BONUS callout
  blocks.push(
    calloutBlock(
      "🎁",
      [rt("PERFORMANCE BONUS:", { bold: true })],
      [
        paragraphText("If a creative performs well in ads, bonuses are added:"),
        paragraphText("5k$ spend → +150$"),
        paragraphText("10k$ spend → +200$"),
        paragraphText("+15k$ spend → +300$"),
        paragraphText(
          "(The more impactful and emotional the edit, the higher the chances of hitting these bonuses.)",
          { italic: true },
        ),
      ],
    ),
  );

  blocks.push(dividerBlock());

  // 2. Ad title + identifier
  blocks.push(heading2Block(adId));
  blocks.push(paragraphText(`Test Ad — ${brief.adsetName}`, { bold: true }));
  blocks.push(paragraphText(hookSuffix(hook), { bold: true }));

  blocks.push(dividerBlock());

  // 3. Reference creative
  if (brief.creativeRef) {
    blocks.push(heading2Block("Reference creative:"));
    blocks.push(paragraphBlock([rt(brief.creativeRef, { link: brief.creativeRef })]));
    blocks.push(
      paragraphText(
        "(This is the competitor Winner ad to replicate with our own footage. Keep the same pacing, narrative structure and emotional intent.)",
        { italic: true },
      ),
    );
    blocks.push(dividerBlock());
  }

  // 4. Script
  if (hook.hookScript?.trim()) {
    blocks.push(heading2Block("Script:"));
    blocks.push(...paragraphParaSplit(hook.hookScript));
    blocks.push(dividerBlock());
  }

  // 5. Filming notes (per-hook notes monteur)
  if (hook.notes?.trim()) {
    blocks.push(heading2Block("Filming notes:"));
    blocks.push(...paragraphParaSplit(hook.notes));
    blocks.push(dividerBlock());
  }

  // 5b. IA / workflow instructions — directives the user wants the
  // SaaS, the monteur, AND any downstream IA prompt to remember. Kept
  // in a dedicated section above the avatar files so the monteur sees
  // them before touching the assets.
  if (hook.aiInstructions?.trim()) {
    blocks.push(heading2Block("Instructions IA / workflow:"));
    blocks.push(...paragraphParaSplit(hook.aiInstructions));
    blocks.push(dividerBlock());
  }

  // 6. AI Avatar (one bullet per finished lipsync, link to Drive file)
  const doneAvatars = hook.avatars.filter(
    (a) => a.lipsyncStatus === "done" && a.lipsyncVideoUrl,
  );
  if (doneAvatars.length > 0) {
    blocks.push(heading2Block("AI Avatar:"));
    blocks.push(paragraphText("File to use:", { bold: true }));
    for (const av of doneAvatars) {
      const label = `${adId} - ${av.label} - AI Avatar Video`;
      blocks.push(
        bulletedItem([
          rt(`${label} → `),
          rt("Drive link", { link: av.lipsyncVideoUrl! }),
        ]),
      );
    }
    blocks.push(
      paragraphText(
        "(This is the full AI avatar video covering the complete script. Overlay anatomical animations during the technical segments.)",
        { italic: true },
      ),
    );
    blocks.push(dividerBlock());
  }

  // 7. Voice over (link to Drive file with the filename as label, matching
  // the user's template exactly)
  if (hook.cutVoUrl) {
    blocks.push(heading2Block("Voice over:"));
    const voLabel = `${adId} - Voice.MP3`;
    blocks.push(paragraphBlock([rt(voLabel, { link: hook.cutVoUrl })]));
    blocks.push(paragraphText("(Important info about voice overs:", { italic: true }));
    blocks.push(
      paragraphText(
        "1. On some voice overs you may hear slight breathing or breath-resetting sounds between sentences. When possible, please remove them — they are very short and quick to take out.",
        { italic: true },
      ),
    );
    blocks.push(
      paragraphText(
        "2. Also, please make sure the voice over is loud enough and well highlighted so it stays perfectly audible on a phone, knowing many users have low/medium volume on social media.)",
        { italic: true },
      ),
    );
    blocks.push(dividerBlock());
  }

  // 8. Content access (shared root Drive folder, link is static)
  blocks.push(heading2Block("Content access:"));
  blocks.push(paragraphBlock([rt(CONTENT_ACCESS_FOLDER_URL, { link: CONTENT_ACCESS_FOLDER_URL })]));
  blocks.push(
    paragraphText(
      "(Content is updated every week. Files are organized clearly and intuitively to make editing and daily work easier.)",
      { italic: true },
    ),
  );
  blocks.push(dividerBlock());

  // 9. Background music — static link to the shared BG Music folder, plus
  //    the two filenames in italic so the monteur knows which track maps
  //    to which segment.
  blocks.push(heading2Block("Background music:"));
  blocks.push(paragraphBlock([rt(BG_MUSIC_FOLDER_URL, { link: BG_MUSIC_FOLDER_URL })]));
  blocks.push(
    numberedItem([
      rt("Beginning of the video (before the solution / product is introduced):", {
        bold: true,
      }),
    ]),
  );
  blocks.push(paragraphText(BG_MUSIC_INTRO_NAME, { italic: true }));
  blocks.push(
    numberedItem([
      rt("From the product introduction to the end of the creative", { bold: true }),
    ]),
  );
  blocks.push(paragraphText(BG_MUSIC_PAYOFF_NAME, { italic: true }));
  blocks.push(
    paragraphText(
      "(These are the tracks that worked best on our current creatives. However, you are free to choose another one if you feel a different background music better fits the creative, rhythm, or mood of the video.)",
      { italic: true },
    ),
  );

  return blocks;
}

// ---------------------------------------------------------------------------
// Route handler — 3 Notion pages per sync (1 per hook variation).
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.brief || !body.brief.id) {
    return NextResponse.json({ error: "brief required" }, { status: 400 });
  }
  const parentId = process.env.NOTION_DATABASE_ID;
  if (!parentId) {
    return NextResponse.json(
      {
        error:
          "NOTION_DATABASE_ID env var manquant côté Vercel. Colle l'ID de ta page/database Notion dans Settings → Environment Variables.",
      },
      { status: 500 },
    );
  }

  try {
    // 1. Upload all media to Drive subfolders (Voiceover, AI Avatar Videos)
    // and replace Supabase URLs with Drive URLs. Throws loudly on any
    // upload failure — we don't want partial Drive / Supabase mix in Notion.
    const { brief: driveBrief } = await processForDrive(body.brief);

    // 2. Sync 3 pages in parallel.
    const pageResults = await Promise.all(
      driveBrief.hooks.map(async (hook) => {
        const title = hookPageTitle(driveBrief, hook);
        const blocks = buildHookPage(driveBrief, hook);
        const inputHook = body.brief?.hooks.find((h) => h.id === hook.id);
        const prevPageId = inputHook?.notionPageId;
        try {
          const result = await syncPageInDatabase(parentId, title, blocks, prevPageId);
          return { hookId: hook.id, ...result };
        } catch (e) {
          return {
            hookId: hook.id,
            pageId: "",
            url: "",
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );

    const failures = pageResults.filter((r) => "error" in r && r.error);
    if (failures.length === pageResults.length) {
      const firstError = (failures[0] as { error: string }).error;
      throw new Error(firstError);
    }

    return NextResponse.json({
      pages: pageResults,
      partial: failures.length > 0,
    });
  } catch (e) {
    let status = 502;
    if (e instanceof NotionAuthError) status = 401;
    else if (e instanceof NotionAccessError) status = 403;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status },
    );
  }
}
