// Briefs — central organising concept of PixelForge.
//
// A brief = an "adset": one creative concept declined as 3 hooks (3 video
// variations). Each hook has its own script variation, its own voice-over,
// and its own avatar lipsyncs. The user walks through the brief as a
// wizard (Setup → Base script → Hook 1 sub-steps → Hook 2 → Hook 3 →
// Final summary) rather than seeing everything at once.
//
// Storage v1: localStorage. Migration of v0 briefs (single hook, flat
// fields) happens on load.

export type BriefTemplate = "simple" | "avatar";

export type LipsyncStatus = "idle" | "processing" | "done" | "failed";

export type AvatarSlot = {
  id: string;
  label: string;
  voClipUrl?: string;
  voClipText?: string;
  imageUrl?: string;
  imagePrompt?: string;
  lipsyncPrompt?: string;
  lipsyncQuality?: "Pro" | "Standard";
  lipsyncBatchId?: string;
  lipsyncTaskId?: string;
  lipsyncStatus?: LipsyncStatus;
  lipsyncError?: string;
  lipsyncVideoUrl?: string;
};

export type HookBrief = {
  id: string;
  index: number; // 1, 2, 3
  // The hook variation's script. Variations usually differ on the opening
  // sentence ('hook') only, but full re-writes are allowed.
  hookScript: string;
  // Raw VO straight from ElevenLabs, intermediate step before cutting.
  mainVoUrl?: string;
  mainVoVoiceName?: string;
  // Cleaned VO — this is the hook's actual finalised voice-over.
  cutVoUrl?: string;
  cutVoDurationSec?: number;
  // Per-hook avatars. Length matches brief.avatarCount when fully filled.
  avatars: AvatarSlot[];
  // Per-video monteur instructions — usually different from one hook to
  // the next (different b-rolls, different captions, etc.). Surfaced both
  // on the hook's Récap step and on the final brief summary.
  notes?: string;
  // Notion sync — one page per hook (1 variation = 1 Notion page).
  notionPageId?: string;
  notionUrl?: string;
};

export type Brief = {
  id: string;
  template: BriefTemplate;
  // Adset name groups the 3 hook variations. Auto-suggested in Step 2.
  adsetName: string;
  // Source script that the 3 hook variations build from.
  baseScript: string;
  // How many avatars per hook (only meaningful for the 'avatar' template).
  avatarCount: number;
  // Optional reference creative (e.g. a competitor's ad we want to emulate).
  creativeRef?: string;
  // Always exactly 3 hooks.
  hooks: HookBrief[];
  createdAt: number;
  updatedAt: number;
  notes?: string;
  // Persisted wizard cursor so the user lands back on their last step.
  currentStepId?: string;
  // Notion sync — set by /api/notion/sync-brief after a successful push so
  // we can archive-and-recreate the same logical page (instead of
  // accumulating duplicates).
  notionPageId?: string;
  notionUrl?: string;
  notionSyncedAt?: number;
};

const STORAGE_KEY = "pf:briefs:v1";
const ATTACH_KEY = "pf:briefAttachTo";

/** Maximum number of AI avatars per hook. Bumped from 5 to 10 once users
 *  started running variants on heavy talking-head campaigns. */
export const MAX_AVATARS_PER_HOOK = 10;

// ---------------------------------------------------------------------------
// IDs + factories
// ---------------------------------------------------------------------------

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Default lipsync prompt for every new avatar. Locked gaze + locked
// camera = the framing the user wants by default. Per-avatar prompts can
// still be edited freely in the wizard.
export const DEFAULT_LIPSYNC_PROMPT =
  "Locked gaze: he maintains direct eye contact with the camera for the entire clip, never glancing to the side. The video plan must not move; it must remain fixed.";

// Older defaults that should be silently upgraded to the current one on
// load — so avatars created before a default change still benefit from
// the latest direction unless the user explicitly customised their prompt.
const LEGACY_LIPSYNC_PROMPTS: ReadonlyArray<string> = [
  "Calm, confident gaze directly at camera. Subtle natural head movement. No exaggerated expressions.",
];

export function newAvatar(label = "Avatar IA"): AvatarSlot {
  return {
    id: randomId("av"),
    label,
    lipsyncPrompt: DEFAULT_LIPSYNC_PROMPT,
    lipsyncQuality: "Pro",
    lipsyncStatus: "idle",
  };
}

function newHook(index: number, avatarCount: number): HookBrief {
  return {
    id: randomId("hk"),
    index,
    hookScript: "",
    avatars:
      avatarCount > 0
        ? Array.from({ length: avatarCount }, (_, i) => newAvatar(`Avatar IA ${i + 1}`))
        : [],
  };
}

// Brief universel — un seul type de brief, avatarCount = 0 signifie pas
// d'avatar IA. hookCount peut aller de 1 à 50 (la plupart des cas: 3,
// mais l'import depuis un Google Doc peut détecter jusqu'à 20+ hooks).
// Le champ `template` reste dans le type pour la rétro-compat des
// briefs en localStorage, mais devient un détail dérivé d'avatarCount.
export function newBrief(options?: {
  avatarCount?: number;
  adsetName?: string;
  hookCount?: number;
}): Brief {
  const ts = Date.now();
  const avatarCount = Math.max(0, Math.min(MAX_AVATARS_PER_HOOK, options?.avatarCount ?? 0));
  const hookCount = Math.max(1, Math.min(50, options?.hookCount ?? 3));
  const template: BriefTemplate = avatarCount > 0 ? "avatar" : "simple";
  const adsetName =
    options?.adsetName?.trim() ||
    `Ad Test #${countExistingBriefsSafe() + 1} — Nouveau brief`;
  return {
    id: randomId("brf"),
    template,
    adsetName,
    baseScript: "",
    avatarCount,
    hooks: Array.from({ length: hookCount }, (_, i) => newHook(i + 1, avatarCount)),
    createdAt: ts,
    updatedAt: ts,
    currentStepId: "setup",
  };
}

function countExistingBriefsSafe(): number {
  try {
    return loadBriefs().length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Suggested adset name from the script
// ---------------------------------------------------------------------------

export function suggestAdsetName(baseScript: string, briefIndex: number): string {
  const idx = briefIndex + 1;
  const cleaned = baseScript.trim();
  if (!cleaned) return `Ad Test #${idx} — Nouveau brief`;
  // First sentence, capped.
  const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned;
  // Use the first ~6 words as the suffix.
  const words = firstSentence.split(/\s+/).slice(0, 6).join(" ");
  const suffix = words.length > 38 ? `${words.slice(0, 38)}…` : words;
  return `Ad Test #${idx} — ${suffix}`;
}

// ---------------------------------------------------------------------------
// Storage helpers (with v0 → v1 migration)
// ---------------------------------------------------------------------------

type LegacyBrief = {
  id: string;
  title?: string;
  template: BriefTemplate;
  createdAt: number;
  updatedAt: number;
  notes?: string;
  script?: string;
  mainVoUrl?: string;
  mainVoVoiceName?: string;
  cutVoUrl?: string;
  cutVoDurationSec?: number;
  avatars?: AvatarSlot[];
};

function isLegacy(b: unknown): b is LegacyBrief {
  return !!b && typeof b === "object" && !("hooks" in b);
}

function migrateLegacy(b: LegacyBrief): Brief {
  const ts = b.createdAt || Date.now();
  const avatars = Array.isArray(b.avatars) ? b.avatars : [];
  const avatarCount =
    b.template === "avatar" ? Math.max(1, Math.min(5, avatars.length || 1)) : 0;
  const hooks: HookBrief[] = [1, 2, 3].map((i) => {
    if (i === 1) {
      // Hook 1 inherits the existing data.
      return {
        id: randomId("hk"),
        index: i,
        hookScript: b.script || "",
        mainVoUrl: b.mainVoUrl,
        mainVoVoiceName: b.mainVoVoiceName,
        cutVoUrl: b.cutVoUrl,
        cutVoDurationSec: b.cutVoDurationSec,
        avatars: avatars.length > 0 ? avatars : newHook(i, avatarCount).avatars,
      };
    }
    return newHook(i, avatarCount);
  });
  return {
    id: b.id,
    template: b.template,
    adsetName: b.title || "Ad Test",
    baseScript: b.script || "",
    avatarCount,
    hooks,
    createdAt: ts,
    updatedAt: b.updatedAt || Date.now(),
    notes: b.notes,
    currentStepId: undefined,
  };
}

// Bump any avatar still on an old default lipsync prompt to the latest one.
// User-customised prompts (anything not in LEGACY_LIPSYNC_PROMPTS) are
// preserved untouched.
function bumpAvatarPrompts(brief: Brief): Brief {
  let changed = false;
  const hooks = brief.hooks.map((h) => {
    const avatars = h.avatars.map((a) => {
      if (a.lipsyncPrompt && LEGACY_LIPSYNC_PROMPTS.includes(a.lipsyncPrompt)) {
        changed = true;
        return { ...a, lipsyncPrompt: DEFAULT_LIPSYNC_PROMPT };
      }
      return a;
    });
    return { ...h, avatars };
  });
  return changed ? { ...brief, hooks } : brief;
}

export function loadBriefs(): Brief[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { briefs?: unknown[] };
    if (!Array.isArray(parsed.briefs)) return [];
    return parsed.briefs
      .map((b) => (isLegacy(b) ? migrateLegacy(b) : (b as Brief)))
      .map(bumpAvatarPrompts);
  } catch {
    return [];
  }
}

export function saveBriefs(briefs: Brief[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ briefs }));
  } catch {
    /* quota */
  }
}

export function loadBrief(id: string): Brief | null {
  return loadBriefs().find((b) => b.id === id) ?? null;
}

export function upsertBrief(brief: Brief): Brief {
  const all = loadBriefs();
  const idx = all.findIndex((b) => b.id === brief.id);
  const updated: Brief = { ...brief, updatedAt: Date.now() };
  if (idx >= 0) all[idx] = updated;
  else all.unshift(updated);
  saveBriefs(all);
  return updated;
}

export function deleteBrief(id: string): void {
  saveBriefs(loadBriefs().filter((b) => b.id !== id));
}

// ---------------------------------------------------------------------------
// Avatar-count synchronisation
// ---------------------------------------------------------------------------

// Safe resize for a single hook's avatar list — never destroys a slot
// that holds an image / VO clip / lipsync. Used by the batch wizard's
// per-hook avatar picker so editing settings on an in-progress batch
// preserves any work already attached to a slot.
export function safeResizeHookAvatars(hook: HookBrief, target: number): HookBrief {
  const clamped = Math.max(0, Math.min(MAX_AVATARS_PER_HOOK, target));
  const cur = hook.avatars;
  if (cur.length === clamped) return hook;
  if (cur.length < clamped) {
    const extras = Array.from({ length: clamped - cur.length }, (_, i) =>
      newAvatar(`Avatar IA ${cur.length + i + 1}`),
    );
    return { ...hook, avatars: [...cur, ...extras] };
  }
  // Shrink: keep all filled slots, drop empties first. Effective floor
  // is the filled count — we never delete data.
  const filled: AvatarSlot[] = [];
  const empties: AvatarSlot[] = [];
  for (const a of cur) {
    const isEmpty = !a.voClipUrl && !a.imageUrl && !a.lipsyncVideoUrl;
    if (isEmpty) empties.push(a);
    else filled.push(a);
  }
  const effectiveTarget = Math.max(clamped, filled.length);
  const keep = [...filled, ...empties].slice(0, effectiveTarget);
  return { ...hook, avatars: keep };
}

// Resize every hook's avatar list to match the desired count. Existing
// slots are preserved (we never destroy a slot that has data). Adding
// slots fills with fresh defaults.
export function syncAvatarCount(brief: Brief, newCount: number): Brief {
  const target = Math.max(0, Math.min(MAX_AVATARS_PER_HOOK, newCount));
  return {
    ...brief,
    avatarCount: target,
    hooks: brief.hooks.map((h) => safeResizeHookAvatars(h, target)),
  };
}

// ---------------------------------------------------------------------------
// Cross-tool attach handoff — sessionStorage slot.
// ---------------------------------------------------------------------------

export type AttachTarget =
  | { kind: "mainVo"; briefId: string; hookId: string }
  | { kind: "cutVo"; briefId: string; hookId: string }
  | { kind: "avatarClip"; briefId: string; hookId: string; avatarId: string }
  | { kind: "avatarImage"; briefId: string; hookId: string; avatarId: string }
  | { kind: "avatarLipsync"; briefId: string; hookId: string; avatarId: string };

// Human-readable label for a target, used by AttachToBriefButton toasts and
// recap views. Keeps i18n-free wording aligned with the wizard's vocabulary.
export function attachTargetLabel(kind: AttachTarget["kind"]): string {
  switch (kind) {
    case "mainVo":
      return "Voix off (brute)";
    case "cutVo":
      return "Voix off finale";
    case "avatarClip":
      return "Voix off de l'avatar";
    case "avatarImage":
      return "Image de l'avatar";
    case "avatarLipsync":
      return "Vidéo lipsync";
  }
}

export function setAttachTarget(target: AttachTarget): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(ATTACH_KEY, JSON.stringify(target));
  } catch {
    /* */
  }
}

export function getAttachTarget(): AttachTarget | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(ATTACH_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as Partial<AttachTarget> & { kind?: string; hookId?: string };
    if (!t.kind || !t.briefId) return null;
    // Backward compat: legacy targets without hookId default to first hook.
    if (!t.hookId) {
      const brief = loadBrief(t.briefId);
      if (!brief || !brief.hooks[0]) return null;
      (t as unknown as { hookId: string }).hookId = brief.hooks[0].id;
    }
    return t as AttachTarget;
  } catch {
    return null;
  }
}

export function clearAttachTarget(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(ATTACH_KEY);
  } catch {
    /* */
  }
}

// Apply a payload to the brief targeted by the attach slot. Returns the
// updated brief or null if anything failed.
export function applyAttach(
  target: AttachTarget,
  payload: {
    url: string;
    durationSec?: number;
    voiceName?: string;
    text?: string;
    prompt?: string;
  },
): Brief | null {
  const brief = loadBrief(target.briefId);
  if (!brief) return null;
  const hook = brief.hooks.find((h) => h.id === target.hookId);
  if (!hook) return null;
  if (target.kind === "mainVo") {
    hook.mainVoUrl = payload.url;
    if (payload.voiceName) hook.mainVoVoiceName = payload.voiceName;
  } else if (target.kind === "cutVo") {
    hook.cutVoUrl = payload.url;
    if (typeof payload.durationSec === "number") {
      hook.cutVoDurationSec = payload.durationSec;
    }
  } else if (target.kind === "avatarClip") {
    const av = hook.avatars.find((a) => a.id === target.avatarId);
    if (!av) return null;
    av.voClipUrl = payload.url;
    if (payload.text) av.voClipText = payload.text;
  } else if (target.kind === "avatarImage") {
    const av = hook.avatars.find((a) => a.id === target.avatarId);
    if (!av) return null;
    av.imageUrl = payload.url;
    if (payload.prompt) av.imagePrompt = payload.prompt;
  } else if (target.kind === "avatarLipsync") {
    const av = hook.avatars.find((a) => a.id === target.avatarId);
    if (!av) return null;
    av.lipsyncVideoUrl = payload.url;
    av.lipsyncStatus = "done";
  }
  return upsertBrief(brief);
}

// Inspect the current value at a target slot WITHOUT mutating anything.
// Returns null if the brief/hook/avatar can't be found; otherwise a tiny
// summary that the AttachToBriefButton picker uses to show "Rempli" vs
// "Vide" state per slot, plus a thumbnail-able URL when relevant.
export function getAttachValue(
  target: AttachTarget,
): { url?: string; meta?: string } | null {
  const brief = loadBrief(target.briefId);
  if (!brief) return null;
  const hook = brief.hooks.find((h) => h.id === target.hookId);
  if (!hook) return null;
  if (target.kind === "mainVo") {
    return { url: hook.mainVoUrl, meta: hook.mainVoVoiceName };
  }
  if (target.kind === "cutVo") {
    return {
      url: hook.cutVoUrl,
      meta:
        typeof hook.cutVoDurationSec === "number"
          ? `${hook.cutVoDurationSec.toFixed(1)}s`
          : undefined,
    };
  }
  const av = hook.avatars.find((a) => a.id === target.avatarId);
  if (!av) return null;
  if (target.kind === "avatarClip") {
    return { url: av.voClipUrl, meta: av.voClipText?.slice(0, 60) };
  }
  if (target.kind === "avatarImage") {
    return { url: av.imageUrl, meta: av.imagePrompt?.slice(0, 60) };
  }
  if (target.kind === "avatarLipsync") {
    return { url: av.lipsyncVideoUrl };
  }
  return null;
}

// Inverse of applyAttach: nulls out the slot at the given target.
// Used by the AttachToBriefButton modal's "Vider" affordance so the
// user can free a slot before attaching a new asset (or remove one
// they mistakenly attached). Returns the updated brief or null.
export function clearAttach(target: AttachTarget): Brief | null {
  const brief = loadBrief(target.briefId);
  if (!brief) return null;
  const hook = brief.hooks.find((h) => h.id === target.hookId);
  if (!hook) return null;
  if (target.kind === "mainVo") {
    hook.mainVoUrl = undefined;
    hook.mainVoVoiceName = undefined;
  } else if (target.kind === "cutVo") {
    hook.cutVoUrl = undefined;
    hook.cutVoDurationSec = undefined;
  } else if (target.kind === "avatarClip") {
    const av = hook.avatars.find((a) => a.id === target.avatarId);
    if (!av) return null;
    av.voClipUrl = undefined;
    av.voClipText = undefined;
  } else if (target.kind === "avatarImage") {
    const av = hook.avatars.find((a) => a.id === target.avatarId);
    if (!av) return null;
    av.imageUrl = undefined;
    av.imagePrompt = undefined;
  } else if (target.kind === "avatarLipsync") {
    const av = hook.avatars.find((a) => a.id === target.avatarId);
    if (!av) return null;
    av.lipsyncVideoUrl = undefined;
    av.lipsyncStatus = "idle";
    av.lipsyncError = undefined;
    av.lipsyncBatchId = undefined;
    av.lipsyncTaskId = undefined;
  }
  return upsertBrief(brief);
}
