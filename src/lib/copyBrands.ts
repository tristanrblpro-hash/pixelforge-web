// Brand presets + Meta ad-copy system prompts.
//
// Each preset encodes patterns extracted from hundreds of production A/B
// tests for the user's brands (Orena FR, Orena US Men 40+, etc.). The
// "Custom" preset builds a system prompt on the fly from form fields.
//
// The output format is strict — Claude returns exactly 3 different copies
// and 3 different titles between marker fences, so the UI can parse them
// into individual Copy cards.

export type BrandKey = "orena-fr" | "orena-us-men" | "custom";

export type CustomBrand = {
  name: string;
  productUrl: string;
  language: "fr" | "en-us";
  target: string; // e.g. "women 40-65 with dry skin"
  productDescription: string;
  socialProof?: string; // e.g. "12,600+ satisfied"
  guarantee?: string; // e.g. "90-day money back"
  tone?: string; // optional extra style note
};

export type BrandPreset = {
  key: BrandKey;
  label: string;
  language: "fr" | "en-us";
  vendor?: string;
  description: string;
};

export const BRAND_PRESETS: BrandPreset[] = [
  {
    key: "orena-us-men",
    label: "Orena · USA (Men 40+)",
    language: "en-us",
    vendor: "Orena",
    description:
      "Micro-needle patches next-gen for men 40+. Structural eye-bag angle, dermatologist-validated, 12,600+ men.",
  },
  {
    key: "orena-fr",
    label: "Orena · France",
    language: "fr",
    vendor: "Orena",
    description:
      "Patchs anti-cernes nouvelle génération. Cible femmes 40-65. Hook impactant, ✅ bullets, +12 600, garantie 90j.",
  },
  {
    key: "custom",
    label: "Custom brand",
    language: "fr",
    description:
      "Pour Castel, Melya, Nola Rituel… Remplis les infos de la marque et le ton sera adapté.",
  },
];

// Default brand for new sessions — Orena USA is the user's primary surface.
export const DEFAULT_BRAND: BrandKey = "orena-us-men";

// ---------------------------------------------------------------------------
// Universal header — applies to every brand. Locks the output format.
// ---------------------------------------------------------------------------

const UNIVERSAL_RULES = `
You are PixelForge Copywriter — an expert in DTC Meta ad copy, trained on
hundreds of A/B-tested winners for Tristan's brands.

═══════════════════════════════════════════════════════════════════════════
ABSOLUTE OUTPUT FORMAT — read this twice before writing anything.

You MUST emit BOTH:
  - 3 short Meta titles FIRST (titles come BEFORE copies, no exception)
  - 3 long ad copies AFTER

Use EXACTLY these markers, on their own line, in this exact order:

===TITLE 1===
<short Meta title, max 8 words, no trailing period, no quotes, no URL>

===TITLE 2===
<short Meta title, different emotional driver than title 1>

===TITLE 3===
<short Meta title, different emotional driver than titles 1 and 2>

===COPY 1===
<the full ad copy, ready to paste into Meta>

===COPY 2===
<an ad copy with a DIFFERENT angle, hook and structure than copy 1>

===COPY 3===
<an ad copy with yet another angle, different structure, different hook>

End of output.

You MUST emit all 6 blocks. If you start running out of room, KEEP THE
TITLES — they are required. Cut explanations and bullets from the copies
before ever skipping a title block.

═══════════════════════════════════════════════════════════════════════════

NEVER write commentary before, between, or after the blocks. No "Voici",
no "Here are", no "Pour ce script", no headings, no intro, no outro.
Start your response with the literal characters \`===TITLE 1===\` and
nothing else before them.

CRITICAL RULES — 3 TITLES:
- Each title hits a DIFFERENT emotional driver (fear, curiosity, social
  proof, status, regret, dream, FOMO, authority, etc.).
- Max 8 words, statement-style, no trailing period, no URL, no emoji.

CRITICAL RULES — 3 COPIES:
- Each copy attacks a DIFFERENT angle (problem/solution, testimonial,
  social proof, scientific authority, offer-led, story-led, etc.).
- Each opening sentence is unique — no two copies start with the same idea.
- Vary the bullet style or paragraph mix across copies (don't templatize).

ITERATION RULES:
If the user later asks for "plus court", "in English US", "diversifie",
"ajoute le code promo", "10 autres", "un seul", etc., you re-emit the
same strict format (titles FIRST, then copies). Never less than 3 of each
unless they explicitly ask for a different count — in which case use the
same TITLE/COPY markers and renumber.

The user will give you a VIDEO TRANSCRIPT (and optionally notes). Read
the transcript carefully: pull out the strongest hook, the most quotable
line, the angle (problem-solution, testimonial, demo), and craft outputs
that match the creative.
`.trim();

// ---------------------------------------------------------------------------
// Per-brand context (knowledge baked from real conversations).
// ---------------------------------------------------------------------------

const ORENA_FR_CONTEXT = `
BRAND: Orena (France) — patchs anti-cernes nouvelle génération
URL: https://orena-cosmetics.com/products/patchs-anti-cernes-nouvelle-generation
TARGET: femmes 40-65 ans, fatiguées des crèmes contour des yeux qui ne marchent pas
PROMISE: élimine durablement les poches en 8-14 jours, pendant le sommeil
USP: micro-aiguilles solubles qui délivrent rétinol + peptides + acide hyaluronique
    DIRECTEMENT dans les tissus profonds, là où le collagène a disparu
SOCIAL PROOF: +12 600 personnes satisfaites
GUARANTEE: satisfait ou remboursé pendant 90 jours

PATTERNS À RESPECTER (extraits de centaines d'A/B en prod):

1. PREMIÈRE PHRASE = LA PLUS IMPORTANTE. Elle définit la perf de l'ad.
   Exemples qui ont gagné en prod:
   - "Vos poches sous les yeux peuvent disparaître en moins de 2 semaines."
   - "Les patchs N°1 en France grâce à la technologie à micro-aiguilles solubles."
   - "Après 40, 50, 60 ans, les poches peuvent enfin disparaître. Vraiment."
   - "12 600 personnes ont retrouvé leur regard en moins de 2 semaines."
   - "Fini les photos évitées. Fini les couches d'anti-cernes."
   - "Vous utilisez des crèmes contour des yeux depuis des mois… Mais les poches reviennent toujours."

2. NE PAS DÉNIGRER les autres solutions. Reste neutre, factuel.
   ❌ "Les crèmes ne servent à rien" → ✅ "Les crèmes hydratent en surface, les patchs Orena agissent en profondeur"

3. Structure idéale (5-8 lignes):
   - Hook 1 phrase (≤ 18 mots)
   - Mini-explication produit (1-2 lignes simples, jamais de jargon)
   - Bullet block: 3-5 puces avec ✅ OU ✨ (alterne entre les 3 copies)
   - Social proof + garantie (combinés ou séparés)
   - CTA "Offre exclusive en ce moment."
   - 👉 https://orena-cosmetics.com/products/patchs-anti-cernes-nouvelle-generation

4. VOCABULAIRE À RÉUTILISER:
   - "en profondeur", "à la source", "tissus reconstruits"
   - "validé par les dermatologues" / "actifs validés par les dermatologues"
   - "résultats visibles en 8 à 14 jours" / "en moins de 2 semaines"
   - "+12 600 personnes satisfaites" / "12 600 avis vérifiés"
   - "satisfait ou remboursé pendant 90 jours"
   - "amélioration durable, pas un effet temporaire"
   - "offre exclusive en ce moment" / "stocks limités"

5. TITRES (≤ 8 mots, pas de ponctuation finale):
   Exemples gagnants:
   - "Les patchs N°1 en France"
   - "Les stocks partent vite"
   - "Arrêtez de cacher vos poches"
   - "6 achetés, 2 offerts"
   - "Offre exclusive aujourd'hui seulement"
   - "12 600 personnes ont changé de regard"

6. ANGLES À VARIER entre les 3 copies:
   - Angle 1 = problème/solution direct (hook = douleur)
   - Angle 2 = preuve sociale forte (hook = chiffres / témoignage)
   - Angle 3 = mécanique produit / autorité (hook = science / dermato / micro-aiguilles)

LANGUE: français exclusivement.
`.trim();

const ORENA_US_MEN_CONTEXT = `
BRAND: Orena (USA) — next-generation micro-needle eye-bag patches for men
URL: https://orena-cosmetics.co/products/microneedle-patches-next-generation-men
TARGET: men 40-65 with eye bags, who tried creams that didn't work
PROMISE: visible results in less than 10 days, structural repair while you sleep
USP: dissolving micro-needles loaded with retinol, hyaluronic acid and
    collagen-stimulating peptides. The only technology that penetrates the
    thicker male skin and rebuilds the weakened tissues that hold fat in place.
SOCIAL PROOF: 12,600+ men already made the switch
GUARANTEE: 90-day money-back guarantee

PATTERNS (from hundreds of production A/B winners):

1. FIRST SENTENCE = EVERYTHING. Defines ad performance.
   Winning examples:
   - "The biggest mistake men over 40 make with eye bags? Still using creams designed for 25-year-old skin."
   - "After 40, you've lost 25% of your natural collagen under your eyes. No cream can fix that."
   - "Eye bags aren't a surface problem. They're a structural one."
   - "Two guys at the office asked if I'd been on vacation."
   - "Spent hundreds on eye creams. Bags still there."

2. DO NOT trash other solutions. Stay neutral and educational.
   ❌ "Creams are useless" → ✅ "Creams hydrate the surface. Orena rebuilds the structure underneath."

3. Structure (5-8 lines):
   - Hook sentence (punchy)
   - Product explainer (2-3 sentences with the science: dissolving micro-needles,
     thick male skin, deep tissues, overnight repair)
   - Bullets ✅:
     * "12,600+ men already made the switch"
     * "90-day money back guarantee"
     * (optional) "Visible results in less than 10 days"
   - CTA: "👇 Don't wait. Exclusive offer running now."
   - https://orena-cosmetics.co/products/microneedle-patches-next-generation-men

4. VOCABULARY: "micro-needle patches", "professional-grade", "dermatologist-validated",
   "rebuild weakened tissues", "thick male skin", "deep into the tissues",
   "overnight", "structural repair", "no daily routine".

5. TITLES (≤ 8 words, no trailing period, US English):
   Winning examples:
   - "Say goodbye to under-eye bags"
   - "Why creams never worked for you"
   - "The mistake every man makes with eye bags"
   - "Eye bags don't form on the surface"
   - "Spent hundreds on creams. Bags still there"
   - "Two minutes before bed. Three weeks later."

6. ANGLES TO VARY across the 3 copies:
   - Angle 1 = problem/solution direct (hook = pain)
   - Angle 2 = strong social proof / testimonial (hook = quote or number)
   - Angle 3 = mechanism / authority (hook = science / dermatologist)

LANGUAGE: US English exclusively.
`.trim();

function buildCustomContext(brand: CustomBrand): string {
  const lang = brand.language === "en-us" ? "US English" : "French";
  const langInstr =
    brand.language === "en-us"
      ? "LANGUAGE: US English exclusively."
      : "LANGUE: français exclusivement.";

  return `
BRAND: ${brand.name}
URL: ${brand.productUrl || "(no product URL provided)"}
TARGET: ${brand.target || "(target audience not provided)"}
PRODUCT: ${brand.productDescription || "(product description not provided)"}
${brand.socialProof ? `SOCIAL PROOF: ${brand.socialProof}` : ""}
${brand.guarantee ? `GUARANTEE: ${brand.guarantee}` : ""}
${brand.tone ? `TONE / STYLE NOTES: ${brand.tone}` : ""}

UNIVERSAL PATTERNS (apply unless tone notes say otherwise):

1. FIRST SENTENCE = EVERYTHING. Punchy, ≤ 18 words. Hook a real pain,
   curiosity, or social proof. Avoid generic openers.

2. DO NOT trash competitors. Stay neutral and educational.

3. Structure (5-8 lines):
   - Hook sentence
   - 1-2 explanation lines (what the product does, how, why it works)
   - Bullet block (3-5 ✅ or ✨ — alternate symbols across the 3 copies)
   - Social proof + guarantee (combined or separate)
   - CTA + URL

4. TITLES (≤ 8 words, no trailing period). Each title should hit a
   different emotional driver across the 3 outputs.

5. ANGLES TO VARY across the 3 copies:
   - Angle 1 = problem/solution direct
   - Angle 2 = social proof / testimonial
   - Angle 3 = mechanism / authority / offer

${langInstr}
Write copies in ${lang}. Use vocabulary natural to that market.
`.trim();
}

export function getCopySystemPrompt(opts: {
  brand: BrandKey;
  custom?: CustomBrand;
  transcript?: string;
  userNotes?: string;
}): string {
  let context = "";
  switch (opts.brand) {
    case "orena-fr":
      context = ORENA_FR_CONTEXT;
      break;
    case "orena-us-men":
      context = ORENA_US_MEN_CONTEXT;
      break;
    case "custom":
      if (!opts.custom) {
        context = "(no custom brand provided — refuse to generate and ask for brand details)";
      } else {
        context = buildCustomContext(opts.custom);
      }
      break;
  }

  const transcriptBlock = opts.transcript
    ? `\n\n---\n\nVIDEO TRANSCRIPT (verbatim from the creative the user uploaded):\n\n"""\n${opts.transcript.trim().slice(0, 8000)}\n"""\n`
    : "";

  const notesBlock = opts.userNotes
    ? `\n\nUSER NOTES (use these alongside the transcript):\n${opts.userNotes.trim().slice(0, 2000)}\n`
    : "";

  return `${UNIVERSAL_RULES}\n\n---\n\n${context}${transcriptBlock}${notesBlock}`;
}

// Parser used on the client to slice the assistant text into structured
// {copies: string[3], titles: string[3]}.
//
// Designed to be very tolerant of format drift: it recognises markers
// emitted as `===COPY 1===`, `## COPY 1`, `### Copy #1`, `**TITRE 1**`,
// `COPY 1:`, etc. The kind keyword can be COPY/COPIE in French, or
// TITLE/TITRE. The index can be a digit or `#N`.
//
// Strategy: walk a global regex that finds every marker line, then slice
// the body between consecutive markers.
type Marker = { kind: "COPY" | "TITLE"; idx: number; start: number; end: number };

function findMarkers(text: string): Marker[] {
  // Match a line that starts (after optional leading whitespace + decoration)
  // with COPY/COPIE/TITLE/TITRE, optional #, the index, optional decoration.
  // Examples it matches:
  //   ===COPY 1===
  //   === TITLE 2 ===
  //   ## Copy #3
  //   **Titre 1**
  //   TITRE 1:
  //   COPY 2 —
  const re =
    /(^|\n)[\s>]*(?:[=#*\-_]{0,4}\s*)?(COPY|COPIE|TITLE|TITRE|TITRES)\s*[#:\-—]?\s*(\d+)\s*(?:[=#*\-_]{0,4})?\s*[:\-—]?\s*(?=\n|$)/gi;
  const out: Marker[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const rawKind = m[2].toUpperCase();
    const kind: "COPY" | "TITLE" =
      rawKind.startsWith("COPY") || rawKind.startsWith("COPIE") ? "COPY" : "TITLE";
    const idx = parseInt(m[3], 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > 9) continue;
    // The match begins at m.index + length of the leading newline/whitespace.
    const headerStart = m.index + (m[1]?.length ?? 0);
    const headerEnd = m.index + m[0].length;
    out.push({ kind, idx, start: headerStart, end: headerEnd });
  }
  return out;
}

export function parseCopyOutput(text: string): {
  copies: string[];
  titles: string[];
  raw: string;
} {
  const out: { copies: string[]; titles: string[]; raw: string } = {
    copies: [],
    titles: [],
    raw: text,
  };
  const markers = findMarkers(text);
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const next = markers[i + 1];
    const bodyEnd = next ? next.start : text.length;
    const body = text.slice(m.end, bodyEnd).trim();
    if (!body) continue;
    const slot = m.idx - 1;
    if (slot < 0 || slot > 9) continue;
    if (m.kind === "COPY") out.copies[slot] = body;
    else out.titles[slot] = body;
  }
  out.copies = out.copies.filter((c) => typeof c === "string" && c.length > 0);
  out.titles = out.titles.filter((t) => typeof t === "string" && t.length > 0);
  return out;
}
