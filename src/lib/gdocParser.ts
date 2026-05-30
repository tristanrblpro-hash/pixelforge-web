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
  /** Full V1 script — body sections concatenated. Already opens with the
   *  Hook 1 line if `hook1Line` is set. */
  v1Script: string;
  hook1Line?: string;
  hook2Line?: string;
  hook3Line?: string;
};

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
const REF_REGEX = /^[ \t]*R[ée]f[eé]rence\s*[:=]\s*(\S.*?)[ \t]*$/im;

// Captures one of the three trailing hook headers. Tolerant of:
//   - "Ad #1 - X - Hook 1 (Original)" / "Ad#1 — X — Hook 1"
//   - the index number after "Hook"
//   - optional parenthesized note like "(Original)"
const HOOK_HEADER_REGEX_G =
  /^[ \t]*Ad\s*#?\s*(\d+)\s*[-–—]\s*.+?[-–—]\s*Hook\s*(\d+)\s*(?:\([^)]*\))?\s*[ \t]*$/gim;

export function parseGoogleDoc(text: string): ParseResult {
  const warnings: string[] = [];
  const ads: ParsedAd[] = [];

  // Normalize newlines (the user pastes from Google Docs which can mix in
  // U+00A0 NBSPs and \r\n).
  const norm = text
    .replace(/\r\n?/g, "\n")
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

  // 2. Find where the hooks section starts (the first "Ad #N - ... - Hook N"
  //    header). Everything before it is the body of V1.
  const hookMatches = [...block.matchAll(HOOK_HEADER_REGEX_G)];

  let bodyEnd = block.length;
  if (hookMatches.length > 0) {
    bodyEnd = hookMatches[0].index ?? block.length;
  }

  // 3. Body = everything between "Référence:" line and the first hook
  //    header. We strip the Référence line itself.
  let body = block.slice(0, bodyEnd).trim();
  if (refMatch) {
    body = body.replace(refMatch[0], "").trim();
  }

  if (!body) {
    warnings.push(`${briefName} : corps de script vide.`);
  }

  // 4. Parse each hook line. The header is matched; the next non-empty
  //    line(s) after it form the quoted line.
  const hookLines: Record<number, string | undefined> = { 1: undefined, 2: undefined, 3: undefined };
  for (let i = 0; i < hookMatches.length; i++) {
    const hm = hookMatches[i];
    const hookIdx = Number(hm[2]); // captures group #2 = the "Hook N" digit
    if (hookIdx !== 1 && hookIdx !== 2 && hookIdx !== 3) continue;
    const start = (hm.index ?? 0) + hm[0].length;
    const end =
      i + 1 < hookMatches.length ? hookMatches[i + 1].index ?? block.length : block.length;
    const segment = block.slice(start, end).trim();
    // Take the first non-empty line. Strip surrounding quotes/whitespace.
    const firstLine = segment.split(/\n/).map((s) => s.trim()).find(Boolean);
    if (firstLine) {
      hookLines[hookIdx] = stripQuotes(firstLine);
    }
  }

  if (!hookLines[1]) warnings.push(`${briefName} : Hook 1 (Original) manquant.`);
  if (!hookLines[2]) warnings.push(`${briefName} : Hook 2 manquant.`);
  if (!hookLines[3]) warnings.push(`${briefName} : Hook 3 manquant.`);

  return {
    briefName,
    creativeName,
    creativeRef,
    v1Script: body,
    hook1Line: hookLines[1],
    hook2Line: hookLines[2],
    hook3Line: hookLines[3],
  };
}

function stripQuotes(s: string): string {
  // Curly + straight + French + guillemets.
  const cleaned = s.replace(/^[\s"'`«“”‘’]+|[\s"'`»“”‘’]+$/g, "");
  return cleaned;
}

// ---------------------------------------------------------------------------
// Build the 3 hook scripts from a parsed ad. Returns { v1, h2, h3 } where:
//   - v1 = the body as-is (already opens with Hook 1 line if present)
//   - h2 = body with the Hook 1 line replaced by Hook 2 line, OR just the
//          Hook 2 line if no Hook 1 to anchor on
//   - h3 = same with Hook 3
// ---------------------------------------------------------------------------

export type HookScripts = {
  v1: string;
  h2: string;
  h3: string;
};

export function buildHookScripts(ad: ParsedAd): HookScripts {
  const body = ad.v1Script;
  const v1 = body;
  const h2 = replaceOpeningOrFallback(body, ad.hook1Line, ad.hook2Line);
  const h3 = replaceOpeningOrFallback(body, ad.hook1Line, ad.hook3Line);
  return { v1, h2, h3 };
}

function replaceOpeningOrFallback(
  body: string,
  hook1Line: string | undefined,
  altLine: string | undefined,
): string {
  if (!altLine) return ""; // user must fill manually
  if (!body) return altLine;
  if (!hook1Line) {
    // No anchor — prepend the alt line so at least the new opening is captured.
    return `${altLine}\n\n${body}`.trim();
  }
  // Try a verbatim replacement.
  if (body.includes(hook1Line)) {
    return body.replace(hook1Line, altLine);
  }
  // Try a normalized comparison (strip whitespace + curly quotes).
  const norm = (s: string) =>
    s.replace(/\s+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
  const nb = norm(body);
  const nh = norm(hook1Line);
  const idx = nb.indexOf(nh);
  if (idx >= 0) {
    // Best-effort: rebuild by slicing on the original body using approximate
    // positions. We rebuild the body around the FIRST sentence that resembles
    // hook1Line.
    // Find the first occurrence of the first ~30 chars of hook1Line in body.
    const probe = hook1Line.slice(0, Math.min(30, hook1Line.length));
    const probeIdx = body.indexOf(probe);
    if (probeIdx >= 0) {
      // Find end-of-sentence after probeIdx (next '.', '!', or '?').
      const tail = body.slice(probeIdx);
      const m = tail.match(/[.!?]/);
      const eos = m ? probeIdx + (m.index ?? 0) + 1 : probeIdx + hook1Line.length;
      return body.slice(0, probeIdx) + altLine + body.slice(eos);
    }
  }
  // Last resort: prepend.
  return `${altLine}\n\n${body}`.trim();
}
