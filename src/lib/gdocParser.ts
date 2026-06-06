// Parser for the user's Google Doc ad-brief format. Pure (no React, no I/O)
// so it's easy to unit-test by hand.
//
// Expected structure per ad (multiple ads concatenated in one doc):
//
//   Ad Test #1 - Anti-Fake Dermato
//
//   Référence: https://app.trendtrack.io/share/ads/...
//
//   HOMME DERMATO LUNETTE #1 :
//   [paragraph — body of V1, scene 1]
//
//   FEMME DERMATO ECRAN SPECIAL :
//   [paragraph — body of V1, scene 2]
//
//   HOMME DERMATO LUNETTE #2)
//   [paragraph — body of V1, scene 3]
//
//   HOMME DERMATO LUNETTE #3
//   [paragraph — body of V1, scene 4]
//
//   Ad #1 - Anti-Fake Dermato - Hook 1 (Original)
//   "Eye bags can actually get worse if you pick up a fake microneedle patch."
//
//   Ad #2 - Anti-Fake Dermato - Hook 2
//    "People keep asking if you're tired..."
//
//   Ad #3 - Anti-Fake Dermato - Hook 3
//   "Those heavy bags under your eyes are the first thing..."
//
// Output: one ParsedAd per "Ad Test #N" block. Hook 1 is the opening
// sentence of V1; Hook 2 and Hook 3 are alternative openings. We build
// V1.script from the body as-is, and Hook 2 / Hook 3 scripts by replacing
// Hook 1's line with the alternative opening in the body.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParsedAd = {
  briefName: string; // e.g. "Ad Test #1"
  creativeName: string; // e.g. "Anti-Fake Dermato"
  creativeRef?: string; // URL from "Référence:" line
  /** Spoken-only body of V1 — scene-marker lines (UPPERCASE setup labels
   *  like "HOMME DERMATO LUNETTE #1 :") are stripped out and surface in
   *  `scenes` instead, so the VO TTS never reads them aloud. */
  v1Script: string;
  /** Scene/setup markers extracted from the body, in the order they
   *  appeared. Drop these into hook.notes so the monteur sees them as
   *  "Filming notes" in Notion without polluting the script. */
  scenes: string[];
  /** Hook opening lines, indexed by hook number - 1.
   *  hookLines[0] = Hook 1 (Original) — also stored as v1Script's first
   *  sentence. hookLines[1] = Hook 2, hookLines[2] = Hook 3, etc.
   *  Length is dynamic: the parser reads as many "Ad #N - … - Hook N"
   *  blocks as the doc contains (1 to 50). Indexes without a line in
   *  the doc are filled with "". */
  hookLines: string[];
  /** Number of AI avatars per hook, indexed same as hookLines.
   *  Parsed from an "Avatars : V1=2, H2=1, H3=0, H4=2…" line (multiple
   *  syntaxes accepted). If absent, undefined → the import flow falls
   *  back to its default slider value for the whole brief. */
  avatarsPerHook?: number[];
  /** Monteur instructions per hook, indexed same as hookLines. Lines
   *  that start with `>` inside the body (→ V1) or inside a hook
   *  section (→ that hook) are collected here. The import flow merges
   *  them with the scene setups into hook.notes (Notion "Filming notes"). */
  hookNotes: string[][];
  /** Directives addressed to the SaaS / IA / workflow per hook. Lines
   *  prefixed with `@` (e.g. "@ Le hook ne remplace pas l'original,
   *  il vient devant") land here. Surfaced as an orange directive card
   *  in the wizard and synced to Notion in its own "Instructions"
   *  section — kept distinct from `hookNotes` so the monteur can tell
   *  filming directions from operational rules. */
  hookAiInstructions: string[][];
};

/** Cap so we don't accidentally create thousands of hooks on a malformed
 *  doc. The user mentioned briefs with up to ~20 hooks, so 50 is plenty. */
const MAX_HOOKS = 50;

export type ParseResult = {
  ads: ParsedAd[];
  /** Soft warnings (e.g. missing reference, missing hook line) so the UI
   *  can flag them but still let the user import. */
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const AD_HEADER_REGEX = /^[ \t]*Ad\s+Test\s*#\s*(\d+)\s*[-–—:]\s*(.+?)[ \t]*$/im;
const AD_HEADER_REGEX_G = /^[ \t]*Ad\s+Test\s*#\s*(\d+)\s*[-–—:]\s*(.+?)[ \t]*$/gim;
// Reference URL — tolerates the URL being on the SAME line ("Référence: <url>")
// OR on the next non-empty line ("Référence :\n<url>"), matching the user's
// template-style layout where each field has its label as a header.
const REF_REGEX =
  /^[ \t]*R[ée]f[eé]rence\s*[:=][ \t]*(?:\r?\n[ \t]*)?(\S[^\n]*?)[ \t]*$/im;

// Avatars line — same multi-line tolerance.
const AVATARS_REGEX =
  /^[ \t]*Avatars?\s*[:=][ \t]*(?:\r?\n[ \t]*)?(\S[^\n]*?)[ \t]*$/im;

// Section labels we want to drop entirely from the body so they don't leak
// into the VO. The user sometimes writes "Script Original :" as a header
// to indicate where the V1 body starts.
const LABEL_LINE_REGEX_G =
  /^[ \t]*(?:Script(?:\s+(?:Original|V1))?|Body|Corps|Texte\s+parl[ée])[ \t]*[:.]?[ \t]*$/gim;

// Captures one of the three trailing hook headers. Very permissive —
// any reasonable shape the user might write:
//
//   - "Ad #1 - X - Hook 1 (Original)"     ← classic
//   - "Ad #2 - X - Hook 2"                ← without parens
//   - "Ad#1 — X — Hook 1"                 ← em/en dash and no space
//   - "Ad #1 - X (Original)"              ← template form, no "Hook 1" word
//   - "Ad #1 (Original)"                  ← minimal form, no title
//   - "Hook 1 (Original)"                 ← no "Ad #N -" prefix
//   - "Hook 2"                            ← bare
//   - "V1 (Original)"                     ← shorthand
//
// Group 1 = "Ad #N" digit (optional — undefined if no Ad prefix).
// Group 2 = explicit "Hook N" digit (undefined when only "(Original)" or
//           "V1" was used). The matching code resolves the final hook
//           index using: explicit Hook number → V1/Original = 1 → Ad
//           number as last fallback.
const HOOK_HEADER_REGEX_G =
  /^[ \t]*(?:Ad\s*#?\s*(\d+)\s*[-–—]\s*[^\n]*?\s*[-–—]?\s*)?(?:Hook\s*(\d+)|V\s*1|\(Original\))(?:\s*\([^)]*\))?[ \t]*[:.]?[ \t]*$/gim;

export function parseGoogleDoc(text: string): ParseResult {
  const warnings: string[] = [];
  const ads: ParsedAd[] = [];

  // Normalize newlines (the user pastes from Google Docs which can mix in
  // U+00A0 NBSPs and \r\n). Then strip personal-note lines (see helper).
  const norm = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !isPersonalNoteLine(line))
    .join("\n")
    .replace(/ /g, " ")
    .trim();

  if (!norm) {
    return { ads, warnings: ["Le texte est vide."] };
  }

  // Slice into AD blocks via "Ad Test #N" headers.
  const matches = [...norm.matchAll(AD_HEADER_REGEX_G)];
  if (matches.length === 0) {
    warnings.push(
      "Aucun header 'Ad Test #N - <nom>' détecté. Vérifie le format du doc.",
    );
    return { ads, warnings };
  }

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const headerEnd = (m.index ?? 0) + m[0].length;
    const nextStart =
      i + 1 < matches.length ? matches[i + 1].index ?? norm.length : norm.length;
    const block = norm.slice(headerEnd, nextStart).trim();
    const briefName = `Ad Test #${m[1]}`;
    const creativeName = m[2].trim();
    const ad = parseAdBlock(briefName, creativeName, block, warnings);
    if (ad) ads.push(ad);
  }

  return { ads, warnings };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function parseAdBlock(
  briefName: string,
  creativeName: string,
  block: string,
  warnings: string[],
): ParsedAd | null {
  // 1. Reference URL (optional)
  let creativeRef: string | undefined;
  const refMatch = block.match(REF_REGEX);
  if (refMatch) {
    creativeRef = refMatch[1].trim();
    // Strip trailing punctuation that may be glued to the URL.
    creativeRef = creativeRef.replace(/[.,;)]+$/, "");
  }

  // 1b. Per-hook avatar counts (optional). If the value is just template
  //     placeholders (e.g. "V1=[ ], H2=[ ], H3=[ ]"), we silently fall
  //     back to the modal's default slider instead of nagging the user.
  //     Parsed length can be 1 (uniform value applied to all hooks)
  //     or any number ≥ 1 — the import flow pads or truncates to match
  //     the actual hook count discovered in step 4.
  let avatarsPerHook: number[] | undefined;
  const avMatch = block.match(AVATARS_REGEX);
  if (avMatch) {
    const rawValue = avMatch[1];
    if (!isTemplatePlaceholder(rawValue)) {
      avatarsPerHook = parseAvatarLine(rawValue) ?? undefined;
      if (!avatarsPerHook) {
        warnings.push(
          `${briefName} : ligne "Avatars: ..." illisible (essai: "V1=2, H2=1, H3=0, H4=1…" ou "2 / 1 / 0 / 1").`,
        );
      }
    }
  }

  // 2. Find where the hooks section starts (the first "Ad #N - ... - Hook N"
  //    header). Everything before it is the body of V1.
  const hookMatches = [...block.matchAll(HOOK_HEADER_REGEX_G)];

  let bodyEnd = block.length;
  if (hookMatches.length > 0) {
    bodyEnd = hookMatches[0].index ?? block.length;
  }

  // 3. Body = everything between "Référence:" line and the first hook
  //    header. We strip the Référence + Avatars metadata lines, peel
  //    out UPPERCASE scene-marker lines, then collect monteur-note
  //    lines (those starting with `>`) into the V1 hook's notes
  //    bucket. All of that runs in sequence so the final body is
  //    pure spoken script.
  let body = block.slice(0, bodyEnd).trim();
  if (refMatch) {
    body = body.replace(refMatch[0], "").trim();
  }
  if (avMatch) {
    body = body.replace(avMatch[0], "").trim();
  }
  // Strip "Script Original :" / "Script :" / "Body :" section labels that
  // the user uses as headers above the V1 body. They are not spoken text.
  body = body.replace(LABEL_LINE_REGEX_G, "").trim();
  const { spoken: bodyAfterScenes, scenes } = stripSceneHeaders(body);
  const { spoken: bodyAfterNotes, notes: v1Notes } = extractMonteurNotes(bodyAfterScenes);
  const { spoken: bodyAfterAi, instructions: v1AiInstr } =
    extractAiInstructions(bodyAfterNotes);
  body = bodyAfterAi;

  if (!body) {
    warnings.push(`${briefName} : corps de script vide.`);
  }

  // 4. Parse each hook line + any monteur notes inside the hook section.
  //    The header is matched; the first non-empty non-note line after it
  //    is the quoted opening. Lines that start with `>` anywhere in
  //    that hook's segment are collected as monteur notes for that hook.
  //    The dict-by-index lets us handle ARBITRARY hook counts (1-50)
  //    — the doc decides how many hooks the brief gets.
  const linesByIdx: Record<number, string | undefined> = {};
  const notesByIdx: Record<number, string[]> = {};
  const aiInstrByIdx: Record<number, string[]> = {};
  let maxHookIdx = 0;

  for (let i = 0; i < hookMatches.length; i++) {
    const hm = hookMatches[i];
    // Resolve the hook index:
    //   - group 2 = explicit "Hook N" digit → use it
    //   - else the matched header used "(Original)" or "V1" → hook = 1
    //   - else fall back to group 1 = "Ad #N" digit (Ad #1=V1, etc.)
    const explicitHook = hm[2] ? Number(hm[2]) : NaN;
    let hookIdx: number;
    if (Number.isFinite(explicitHook)) {
      hookIdx = explicitHook;
    } else if (/\(Original\)|V\s*1/i.test(hm[0])) {
      hookIdx = 1;
    } else if (hm[1]) {
      hookIdx = Number(hm[1]);
    } else {
      continue;
    }
    if (hookIdx < 1 || hookIdx > MAX_HOOKS) continue;
    if (hookIdx > maxHookIdx) maxHookIdx = hookIdx;
    if (!notesByIdx[hookIdx]) notesByIdx[hookIdx] = [];
    if (!aiInstrByIdx[hookIdx]) aiInstrByIdx[hookIdx] = [];

    const start = (hm.index ?? 0) + hm[0].length;
    const end =
      i + 1 < hookMatches.length ? hookMatches[i + 1].index ?? block.length : block.length;
    const segment = block.slice(start, end).trim();

    let openingTaken = false;
    for (const rawLine of segment.split(/\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith(">")) {
        const clean = trimmed.replace(/^>+\s*/, "").trim();
        if (clean) notesByIdx[hookIdx].push(clean);
        continue;
      }
      if (trimmed.startsWith("@")) {
        const clean = trimmed.replace(/^@+\s*/, "").trim();
        if (clean) aiInstrByIdx[hookIdx].push(clean);
        continue;
      }
      // First non-note, non-empty line is the quoted opening — unless
      // it's still a template placeholder like "[   ]", in which case
      // we treat it as empty.
      if (!openingTaken) {
        const cleaned = stripQuotes(trimmed);
        if (!isTemplatePlaceholder(cleaned)) {
          linesByIdx[hookIdx] = cleaned;
        }
        openingTaken = true;
      }
    }
  }

  // Convert the dict to a dense array sized to the highest hook index
  // (at least 1 — every brief has V1 even if the doc only describes V1).
  const totalHooks = Math.max(1, maxHookIdx);
  const finalHookLines: string[] = [];
  const finalHookNotes: string[][] = [];
  const finalHookAiInstructions: string[][] = [];
  for (let idx = 1; idx <= totalHooks; idx++) {
    finalHookLines.push(linesByIdx[idx] ?? "");
    const notes = notesByIdx[idx] ?? [];
    const ai = aiInstrByIdx[idx] ?? [];
    // V1 (idx=1) also receives any body-level monteur notes / IA
    // instructions (lines starting with `>` or `@` that appear in the
    // body before any hook header).
    if (idx === 1) {
      finalHookNotes.push([...v1Notes, ...notes]);
      finalHookAiInstructions.push([...v1AiInstr, ...ai]);
    } else {
      finalHookNotes.push(notes);
      finalHookAiInstructions.push(ai);
    }
  }

  // Hook 1's line is intentionally NOT required: V1's VO uses the full
  // body of the original script (not just the opening), so a missing
  // Hook 1 line doesn't actually break anything. We only warn for
  // Hook 2+ because those are stand-alone openings that drive their
  // own VO renders. With dynamic hook counts, we warn for any hook
  // index ≥ 2 whose opening line is empty.
  for (let idx = 2; idx <= totalHooks; idx++) {
    if (!finalHookLines[idx - 1]) {
      warnings.push(`${briefName} : Hook ${idx} manquant.`);
    }
  }

  return {
    briefName,
    creativeName,
    creativeRef,
    v1Script: body,
    scenes,
    hookLines: finalHookLines,
    avatarsPerHook,
    hookNotes: finalHookNotes,
    hookAiInstructions: finalHookAiInstructions,
  };
}

// Extract monteur-note lines (those starting with `>`) from a free-form
// text blob. Returns the text minus those lines + the collected notes
// (cleaned of the `>` prefix and surrounding whitespace).
function extractMonteurNotes(text: string): { spoken: string; notes: string[] } {
  const lines = text.split(/\n/);
  const spokenLines: string[] = [];
  const notes: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.startsWith(">")) {
      const clean = trimmed.replace(/^>+\s*/, "").trim();
      if (clean) notes.push(clean);
      continue;
    }
    spokenLines.push(raw);
  }
  const spoken = spokenLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { spoken, notes };
}

// Sibling of extractMonteurNotes for `@`-prefixed IA / workflow
// directives. Same shape — pull them out of the spoken body and return
// them separately so the VO never reads them aloud and the wizard can
// surface them as their own "Instructions" card.
function extractAiInstructions(text: string): { spoken: string; instructions: string[] } {
  const lines = text.split(/\n/);
  const spokenLines: string[] = [];
  const instructions: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("@")) {
      const clean = trimmed.replace(/^@+\s*/, "").trim();
      if (clean) instructions.push(clean);
      continue;
    }
    spokenLines.push(raw);
  }
  const spoken = spokenLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { spoken, instructions };
}

// ---------------------------------------------------------------------------
// "Avatars : ..." parser
//
// Returns an array of avatar counts indexed by hook (V1 at index 0).
// Accepted forms (each digit clamped to 0..5):
//   "V1=2, H2=1, H3=0"              (labeled — supports H1..H50)
//   "V1: 2, Hook 2: 1, Hook 3: 0, Hook 7: 1"
//   "Hook 1=2, Hook 2=1, Hook 3=0"
//   "2 / 1 / 0 / 1 / 1 / 0 / 0"      (slash-separated, V1, H2, H3…)
//   "2, 1, 0"                         (comma-separated)
//   "2"                               (uniform — caller expands to all hooks)
// Returns null if nothing parseable. Returns [n] (length 1) for the
// uniform case so the caller knows to broadcast.
// ---------------------------------------------------------------------------

function parseAvatarLine(raw: string): number[] | null {
  const s = raw.trim();
  if (!s) return null;

  // 1. Labeled form (V1=2, H2=1, H7=1, ...) — supports arbitrary indices.
  //    Captures both the index digit AND the avatar count.
  const labeled: Record<number, number> = {};
  const labelRegex = /(?:V\s*|Hook\s*|H)(\d{1,2})\s*[:=]\s*(\d+)/gi;
  let any = false;
  for (const m of s.matchAll(labelRegex)) {
    const idx = parseInt(m[1], 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > 50) continue;
    const n = clampAvatar(parseInt(m[2], 10));
    if (n === null) continue;
    labeled[idx] = n;
    any = true;
  }
  if (any) {
    const maxIdx = Math.max(...Object.keys(labeled).map(Number));
    const out: number[] = [];
    for (let i = 1; i <= maxIdx; i++) out.push(labeled[i] ?? 0);
    return out;
  }

  // 2. Slash or comma-separated list. ≥2 numbers required so we don't
  //    mis-classify a single-digit single value here.
  const parts = s.split(/[\/,]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2 && parts.every((p) => /^\d+$/.test(p))) {
    const nums = parts.map((p) => clampAvatar(parseInt(p, 10)));
    if (nums.every((n): n is number => n !== null)) {
      return nums as number[];
    }
  }

  // 3. Single number → uniform. Caller broadcasts to all hooks.
  if (/^\d+$/.test(s)) {
    const n = clampAvatar(parseInt(s, 10));
    if (n !== null) return [n];
  }

  return null;
}

function clampAvatar(n: number): number | null {
  if (Number.isNaN(n) || n < 0) return null;
  // Capped at 10 (the brief data model's MAX_AVATARS_PER_HOOK). Higher
  // values from the doc are silently clamped — the user can bump in the
  // wizard's Avatars step if they need to.
  return Math.min(10, n);
}

// ---------------------------------------------------------------------------
// Template placeholder detection
//
// The user works from a Google Doc template that contains placeholders
// like "[   ]" or "[Title]" that should be replaced when filling in a
// brief. When a placeholder is left empty, we treat the field as "not
// specified" silently — no warning, no crash, just defaults kick in.
//
// A value is a placeholder if it's:
//   - empty after trimming
//   - made of nothing but []/brackets, whitespace, and known structural
//     markers (V1/H2/H3/=/, etc. for the Avatars line)
//   - just "[" + anything + "]"
// ---------------------------------------------------------------------------

function isTemplatePlaceholder(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  // Strip out everything that looks like a [bracket placeholder] —
  // including with whitespace inside. If what's left has no actual
  // content (just commas, slashes, labels, etc.), it's a template.
  const withoutBrackets = trimmed.replace(/\[[^\]]*\]/g, "").trim();
  if (!withoutBrackets) return true;
  // After stripping brackets, what remains should contain at least one
  // digit OR a real word (not just labels like "V1=" or punctuation).
  // We consider it a placeholder if there are no digits AND no
  // lowercase letters (labels like "V1=" are uppercase-only).
  if (!/\d/.test(withoutBrackets) && !/[a-z]/.test(withoutBrackets)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scene-header extraction
//
// A "scene header" is a non-spoken filming direction the user inlines
// inside a script (e.g. "HOMME DERMATO LUNETTE #1 :", "FEMME DERMATO
// ECRAN SPECIAL :", "HOMME DERMATO LUNETTE #2)"). We detect them as
// short, all-uppercase standalone lines so they can be peeled out of
// the body that feeds the TTS, without losing the filming setup info
// (we return it separately so the import flow can drop it into
// hook.notes / brief.notes).
//
// Heuristic chosen for robustness:
//   - whole line is uppercase (no lowercase letter present at all),
//   - at least 3 alphabetic characters (skip stray single CAPS abbrev),
//   - line length <= 100 chars (a sentence in CAPS rarely fits).
// This catches every example in the user's Google Doc convention and
// won't strip emphasis CAPS embedded inside a longer line of prose.
// ---------------------------------------------------------------------------

export function stripSceneHeaders(text: string): { spoken: string; scenes: string[] } {
  const lines = text.split(/\n/);
  const spokenLines: string[] = [];
  const scenes: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      spokenLines.push("");
      continue;
    }
    if (isSceneHeader(trimmed)) {
      const clean = trimmed.replace(/[\s:);.,]+$/, "").trim();
      if (clean) scenes.push(clean);
      // dropped — don't append to spokenLines
      continue;
    }
    spokenLines.push(raw);
  }
  // Collapse runs of blank lines created by the deletions.
  const spoken = spokenLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { spoken, scenes };
}

function isSceneHeader(line: string): boolean {
  if (line.length > 100) return false;
  const alphaMatches = line.match(/[A-Za-zÀ-ÿ]/g);
  if (!alphaMatches || alphaMatches.length < 3) return false;
  // Whole line must be uppercase — i.e. it equals its own toUpperCase().
  // Numbers, spaces and punctuation are unchanged by toUpperCase so this
  // works on "HOMME DERMATO LUNETTE #1 :" but not on a normal sentence.
  if (line !== line.toUpperCase()) return false;
  return true;
}

function stripQuotes(s: string): string {
  // Curly + straight + French + guillemets.
  const cleaned = s.replace(/^[\s"'`«“”‘’]+|[\s"'`»“”‘’]+$/g, "");
  return cleaned;
}

// ---------------------------------------------------------------------------
// Build the hook scripts from a parsed ad.
//
// Workflow convention (set by the user):
//   - V1 (index 0) holds the FULL original script (entire body) → the
//     V1 voice off is the long ~3-4 min recording used as the spine of
//     every variant.
//   - Hook 2+ (index 1+) hold ONLY their replacement opening line. The
//     monteur splices the short Hook N VO at the start of the V1 video
//     after cutting out V1's own opening. Generating the full body
//     again for Hooks 2+ would just produce 3 minutes of duplicate
//     audio for no reason.
//
// Returns an array sized to ad.hookLines.length (1 to 50). scripts[0] =
// V1's full body, scripts[i] = hookLines[i] for i ≥ 1.
// ---------------------------------------------------------------------------

export function buildHookScripts(ad: ParsedAd): string[] {
  const result: string[] = [];
  // V1 always carries the full body, regardless of whether hookLines[0]
  // (= the Hook 1 / Original line) was parsed out separately.
  result.push(ad.v1Script);
  for (let i = 1; i < ad.hookLines.length; i++) {
    result.push(ad.hookLines[i] ?? "");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Personal-note line detection
//
// Any line whose first non-whitespace character is `*` is a personal
// note — completely dropped from the doc before any other parsing
// happens. Notes never reach the VO TTS, the Notion filming notes, or
// even the script preview. Examples:
//
//   * à valider avec le client
//   ** Important : ne pas oublier la musique
//   *Note rapide sans espace après l'étoile
//
// A `*` in the middle of a normal sentence (e.g. "Buy 1 * pack") stays
// untouched — the detection only triggers when `*` is the very first
// non-space character on the line.
// ---------------------------------------------------------------------------

export function isPersonalNoteLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return trimmed.startsWith("*");
}
