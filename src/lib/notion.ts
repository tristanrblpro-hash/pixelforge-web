// Notion REST client. Server-only.
//
// We deliberately avoid the @notionhq/client SDK to keep the dependency
// surface tiny and the build fast. The Notion REST API is well documented
// at https://developers.notion.com.
//
// Auth: reads NOTION_API_KEY at call time (never bundled into client JS).
// The destination database id is read from NOTION_DATABASE_ID by the API
// route on top of this lib.

const API_BASE = "https://api.notion.com/v1";
const API_VERSION = "2022-06-28";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class NotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotionError";
  }
}
export class NotionAuthError extends NotionError {
  constructor(message: string) {
    super(message);
    this.name = "NotionAuthError";
  }
}
export class NotionAccessError extends NotionError {
  constructor(message: string) {
    super(message);
    this.name = "NotionAccessError";
  }
}

function requireKey(): string {
  const k = process.env.NOTION_API_KEY;
  if (!k) {
    throw new NotionAuthError("NOTION_API_KEY env var is not set on the server.");
  }
  return k;
}

function authHeader() {
  return {
    Authorization: `Bearer ${requireKey()}`,
    "Notion-Version": API_VERSION,
    "Content-Type": "application/json",
  } as const;
}

async function handleResponse(r: Response, label: string): Promise<Record<string, unknown>> {
  if (r.status === 401) {
    throw new NotionAuthError(`Notion ${label}: 401 — vérifie l'API key.`);
  }
  if (r.status === 403) {
    throw new NotionAccessError(
      `Notion ${label}: 403 — l'intégration n'a pas accès à la database (clique « Connections » sur la database et ajoute l'intégration).`,
    );
  }
  const text = await r.text();
  if (r.status === 404) {
    throw new NotionAccessError(
      `Notion ${label}: 404 — database introuvable. Vérifie l'ID et que l'intégration est connectée. (${text.slice(0, 160)})`,
    );
  }
  if (!r.ok) {
    throw new NotionError(`Notion ${label}: HTTP ${r.status} — ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new NotionError(`Notion ${label}: non-JSON response`);
  }
}

// ---------------------------------------------------------------------------
// Parent introspection — Notion accepts either a database (rows are pages)
// or a regular page (children are sub-pages). The sync logic dispatches
// based on what the user's env-var ID actually points at.
// ---------------------------------------------------------------------------

export type ParentKind = "database" | "page";

export async function detectParentKind(id: string): Promise<ParentKind> {
  const r = await fetch(`${API_BASE}/databases/${id}`, { headers: authHeader() });
  if (r.ok) return "database";
  const text = await r.text();
  if (r.status === 400 && /is a page, not a database/i.test(text)) {
    return "page";
  }
  if (r.status === 401) {
    throw new NotionAuthError("Notion detect parent: 401 — vérifie l'API key.");
  }
  if (r.status === 403) {
    throw new NotionAccessError(
      "Notion detect parent: 403 — l'intégration n'a pas accès à cette page/database (Connexions).",
    );
  }
  if (r.status === 404) {
    throw new NotionAccessError(
      "Notion detect parent: 404 — l'ID est introuvable ou non accessible.",
    );
  }
  throw new NotionError(`Notion detect parent: HTTP ${r.status} — ${text.slice(0, 200)}`);
}

export async function getDatabaseTitleProp(databaseId: string): Promise<string> {
  const r = await fetch(`${API_BASE}/databases/${databaseId}`, {
    headers: authHeader(),
  });
  const data = await handleResponse(r, "get database");
  const props = (data.properties as Record<string, { type?: string }>) || {};
  for (const [name, prop] of Object.entries(props)) {
    if (prop?.type === "title") return name;
  }
  // Fallback: most Notion databases call the title column "Name".
  return "Name";
}

// ---------------------------------------------------------------------------
// Page creation + child block append
// ---------------------------------------------------------------------------

// Notion blocks are loosely typed JSON — we keep them as Record<string, unknown>
// to avoid forcing the entire schema into our types.
export type NotionBlock = Record<string, unknown>;

const NOTION_MAX_CHILDREN_PER_REQUEST = 100;

async function appendChildren(pageId: string, blocks: NotionBlock[]): Promise<void> {
  for (let i = 0; i < blocks.length; i += NOTION_MAX_CHILDREN_PER_REQUEST) {
    const chunk = blocks.slice(i, i + NOTION_MAX_CHILDREN_PER_REQUEST);
    const r = await fetch(`${API_BASE}/blocks/${pageId}/children`, {
      method: "PATCH",
      headers: authHeader(),
      body: JSON.stringify({ children: chunk }),
    });
    await handleResponse(r, "append blocks");
  }
}

async function archivePage(pageId: string): Promise<void> {
  const r = await fetch(`${API_BASE}/pages/${pageId}`, {
    method: "PATCH",
    headers: authHeader(),
    body: JSON.stringify({ archived: true }),
  });
  // Don't throw if the page is gone — re-sync should still succeed.
  if (r.status === 404) return;
  await handleResponse(r, "archive page");
}

export type CreatePageResult = { pageId: string; url: string };

export async function createPageInDatabase(
  databaseId: string,
  title: string,
  blocks: NotionBlock[],
): Promise<CreatePageResult> {
  const titleProp = await getDatabaseTitleProp(databaseId);
  // First call: create the page with the first up-to-100 blocks.
  const head = blocks.slice(0, NOTION_MAX_CHILDREN_PER_REQUEST);
  const tail = blocks.slice(NOTION_MAX_CHILDREN_PER_REQUEST);

  const r = await fetch(`${API_BASE}/pages`, {
    method: "POST",
    headers: authHeader(),
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties: {
        [titleProp]: {
          title: [{ text: { content: title.slice(0, 1900) } }],
        },
      },
      children: head,
    }),
  });
  const data = await handleResponse(r, "create page");
  const pageId = String(data.id || "");
  const url = String(data.url || "");
  if (tail.length > 0) {
    await appendChildren(pageId, tail);
  }
  return { pageId, url };
}

// Create a sub-page under a regular Notion page (parent isn't a database).
// Child pages don't have database properties — title goes in the page's
// own 'title' property.
export async function createChildPage(
  parentPageId: string,
  title: string,
  blocks: NotionBlock[],
): Promise<CreatePageResult> {
  const head = blocks.slice(0, NOTION_MAX_CHILDREN_PER_REQUEST);
  const tail = blocks.slice(NOTION_MAX_CHILDREN_PER_REQUEST);

  const r = await fetch(`${API_BASE}/pages`, {
    method: "POST",
    headers: authHeader(),
    body: JSON.stringify({
      parent: { page_id: parentPageId },
      properties: {
        title: {
          title: [{ type: "text", text: { content: title.slice(0, 1900) } }],
        },
      },
      children: head,
    }),
  });
  const data = await handleResponse(r, "create child page");
  const pageId = String(data.id || "");
  const url = String(data.url || "");
  if (tail.length > 0) {
    await appendChildren(pageId, tail);
  }
  return { pageId, url };
}

// Sync = "make Notion match this brief". v1 is archive-and-recreate. The new
// page comes back with a fresh URL — we surface it so the caller can store
// it on the brief and open it.
//
// The parentId env var can point at either a database (rows are pages) or
// a regular page (children are sub-pages). We auto-detect and dispatch.
export async function syncPageInDatabase(
  parentId: string,
  title: string,
  blocks: NotionBlock[],
  previousPageId?: string,
): Promise<CreatePageResult> {
  if (previousPageId) {
    try {
      await archivePage(previousPageId);
    } catch {
      /* best-effort — old page may have been hand-deleted in Notion */
    }
  }
  const kind = await detectParentKind(parentId);
  if (kind === "database") {
    return createPageInDatabase(parentId, title, blocks);
  }
  return createChildPage(parentId, title, blocks);
}

// ---------------------------------------------------------------------------
// Block factory helpers — keep the brief-to-Notion conversion readable
// ---------------------------------------------------------------------------

const RICH_TEXT_MAX = 2000; // Notion caps rich_text content per item.

function splitForRichText(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const out: string[] = [];
  for (let i = 0; i < t.length; i += RICH_TEXT_MAX) {
    out.push(t.slice(i, i + RICH_TEXT_MAX));
  }
  return out;
}

export function heading1(content: string): NotionBlock {
  return {
    object: "block",
    type: "heading_1",
    heading_1: { rich_text: [{ type: "text", text: { content: content.slice(0, RICH_TEXT_MAX) } }] },
  };
}
export function heading2(content: string): NotionBlock {
  return {
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: [{ type: "text", text: { content: content.slice(0, RICH_TEXT_MAX) } }] },
  };
}
export function heading3(content: string): NotionBlock {
  return {
    object: "block",
    type: "heading_3",
    heading_3: { rich_text: [{ type: "text", text: { content: content.slice(0, RICH_TEXT_MAX) } }] },
  };
}
export function paragraph(content: string): NotionBlock[] {
  return splitForRichText(content).map((chunk) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
  }));
}
export function divider(): NotionBlock {
  return { object: "block", type: "divider", divider: {} };
}
export function bullet(content: string): NotionBlock {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [{ type: "text", text: { content: content.slice(0, RICH_TEXT_MAX) } }],
    },
  };
}
export function bulletWithLink(label: string, url: string): NotionBlock {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [
        {
          type: "text",
          text: { content: `${label}: `, link: null },
          annotations: { bold: true },
        },
        {
          type: "text",
          text: { content: url, link: { url } },
        },
      ],
    },
  };
}
export function callout(content: string, emoji = "📌"): NotionBlock {
  return {
    object: "block",
    type: "callout",
    callout: {
      icon: { type: "emoji", emoji },
      rich_text: [{ type: "text", text: { content: content.slice(0, RICH_TEXT_MAX) } }],
    },
  };
}
export function externalVideo(url: string): NotionBlock {
  return {
    object: "block",
    type: "video",
    video: { type: "external", external: { url } },
  };
}
export function externalAudio(url: string): NotionBlock {
  // Notion accepts external audio URLs (they render as an embed).
  return {
    object: "block",
    type: "audio",
    audio: { type: "external", external: { url } },
  };
}
export function externalImage(url: string): NotionBlock {
  return {
    object: "block",
    type: "image",
    image: { type: "external", external: { url } },
  };
}
export function linkBlock(label: string, url: string): NotionBlock {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        { type: "text", text: { content: `${label}: ` }, annotations: { bold: true } },
        { type: "text", text: { content: url, link: { url } } },
      ],
    },
  };
}
