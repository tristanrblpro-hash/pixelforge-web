"use client";

// BriefBatchWizard — weekly "prepare 10 briefs at once" flow.
//
// Steps:
//   ① Briefs    — multi-add (brief name + creative name + avatar count)
//   ② Scripts   — per-brief card with the 3 hook scripts + optional notes
//   ③ VO        — per-brief card, parallel ElevenLabs gen + "Cut blanks"
//   ④ Images    — per-brief mini-cards with "X/Y images" completion badge
//   ⑤ Lipsync   — per-brief card, parallel Kling lipsync gen + polling
//   ⑥ Sync      — push every brief to Notion + Drive in parallel
//
// Cross-step UX:
// - Larger typography (text-base body, text-lg subtitles, text-2xl titles)
// - One card per brief everywhere (no dense tables)
// - Persistent state in sessionStorage so navigating to /cut-silence and
//   back doesn't reset the wizard
// - Cut blanks routes to /cut-silence with audio preloaded + attach
//   target preset; the studio routes back via `pf:cutSilenceReturnTo`

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  Mic,
  Pause,
  Plus,
  RefreshCw,
  Scissors,
  Sparkles,
  Upload,
  Users,
  Video,
  X,
} from "lucide-react";

import {
  type AvatarSlot,
  type Brief,
  type HookBrief,
  MAX_AVATARS_PER_HOOK,
  applyAttach,
  clearAttach,
  loadBriefs,
  newBrief,
  safeResizeHookAvatars,
  setAttachTarget,
  upsertBrief,
} from "@/lib/briefs";
import { runVoiceoverBatch, type VoBatchJob } from "@/lib/voiceoverBatch";
import { uploadFileToStorage } from "@/lib/uploadFile";
import { GdocImportModal } from "@/components/GdocImportModal";
import { UploadAndAttachButton } from "@/components/AttachToBriefButton";

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type StepId = 1 | 2 | 3 | 4 | 5 | 6 | 7;

type DraftRow = {
  rowId: string;
  briefName: string;
  creativeName: string;
  avatarCount: number;
  /** Filled after step 1 commits. */
  briefId?: string;
};

type Voice = {
  voiceId: string;
  name: string;
  category?: string;
};

type VoCellStatus = "idle" | "running" | "done" | "error";
type VoCellState = {
  status: VoCellStatus;
  error?: string;
  url?: string;
};

type LsCellStatus = "idle" | "running" | "done" | "error";
type LsCellState = {
  status: LsCellStatus;
  error?: string;
  url?: string;
  // KIE batch id, set when "running" so we can resume polling after a
  // page reload / nav (otherwise the in-memory setInterval dies and the
  // row stays stuck in "En cours" forever even though Kling is done).
  batchId?: string;
};

type SyncCellState = {
  status: "idle" | "running" | "done" | "error";
  error?: string;
  url?: string;
};

// Same favorites as VoiceoverStudio.
const FAVORITE_VOICE_IDS = [
  "T4x5CtnhOiichhcqFzgg",
  "G0yjIg3xY8gEJZkHpjVm",
] as const;

// ElevenLabs model choices surfaced in the Step 4 control bar. "V2.5" is
// the model we've always generated with (eleven_multilingual_v2) — kept as
// the default so nothing changes for existing batches. "V3" is the new
// eleven_v3 model; our TTS client already drops previous_text/next_text for
// it (V3 rejects those), so it works through the same generate route.
const VO_MODEL_OPTIONS = [
  { id: "eleven_multilingual_v2", label: "V2.5" },
  { id: "eleven_v3", label: "V3" },
] as const;
const VO_MODEL_DEFAULT = "eleven_v3";

// v1 → v2 migration was triggered by inserting the new "Avatars" step
// at position 2, which shifts every later step by +1 (Scripts 2→3,
// Voix off 3→4, Images 4→5, Lipsync 5→6, Sync 6→7). We bump the key
// so the migration code can detect old persisted state and transparently
// teleport users to the correctly-numbered step on first load after
// deploy — without losing their work-in-progress (rows, voState,
// lipsyncState all carry over verbatim).
const SESSION_STATE_KEY_V1 = "pf:batchWizard:v1";
const SESSION_STATE_KEY = "pf:batchWizard:v2";

// ---------------------------------------------------------------------------
// SessionStorage persistence — survives a hop to /cut-silence and back
// ---------------------------------------------------------------------------

type PersistedState = {
  step: StepId;
  rows: DraftRow[];
  voState: Array<[string, VoCellState]>;
  lipsyncState: Array<[string, LsCellState]>;
};

function loadWizardState(): PersistedState | null {
  if (typeof window === "undefined") return null;
  try {
    // Prefer v2 if it exists.
    const rawV2 = window.sessionStorage.getItem(SESSION_STATE_KEY);
    if (rawV2) return JSON.parse(rawV2) as PersistedState;

    // Otherwise migrate v1 → v2 in-place. v1 numbered:
    //   1 Briefs · 2 Scripts · 3 VO · 4 Images · 5 Lipsync · 6 Sync
    // v2 numbered:
    //   1 Briefs · 2 Avatars (NEW) · 3 Scripts · 4 VO · 5 Images ·
    //   6 Lipsync · 7 Sync
    // So step > 1 shifts by +1; step = 1 stays put.
    const rawV1 = window.sessionStorage.getItem(SESSION_STATE_KEY_V1);
    if (!rawV1) return null;
    const v1 = JSON.parse(rawV1) as PersistedState;
    const oldStep = Math.max(1, Math.min(6, v1.step));
    const newStep: StepId = oldStep === 1 ? 1 : ((oldStep + 1) as StepId);
    const migrated: PersistedState = {
      step: newStep,
      rows: v1.rows,
      voState: v1.voState,
      lipsyncState: v1.lipsyncState,
    };
    window.sessionStorage.setItem(SESSION_STATE_KEY, JSON.stringify(migrated));
    window.sessionStorage.removeItem(SESSION_STATE_KEY_V1);
    return migrated;
  } catch {
    return null;
  }
}

function saveWizardState(s: PersistedState) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SESSION_STATE_KEY, JSON.stringify(s));
  } catch {
    /* quota — skip */
  }
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function BriefBatchWizard() {
  const router = useRouter();
  const hydrated = useRef(false);

  const [step, setStep] = useState<StepId>(1);
  const [rows, setRows] = useState<DraftRow[]>(() =>
    Array.from({ length: 5 }, () => makeRow()),
  );
  const [briefs, setBriefs] = useState<Map<string, Brief>>(new Map());

  // VO state
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState<string>("");
  // ElevenLabs model used for the whole batch. Defaults to the model we've
  // always used ("V2.5") so existing behaviour is unchanged; the user can
  // switch to "V3" from the Step 4 control bar.
  const [voModelId, setVoModelId] = useState<string>(VO_MODEL_DEFAULT);
  const [voState, setVoState] = useState<Map<string, VoCellState>>(new Map());
  const voAbortRef = useRef<AbortController | null>(null);

  // Lipsync state
  const [lipsyncState, setLipsyncState] = useState<Map<string, LsCellState>>(new Map());
  const lsPollersRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const lsAbortRef = useRef<AbortController | null>(null);

  // Sync state
  const [syncState, setSyncState] = useState<Map<string, SyncCellState>>(new Map());

  // Google Doc import modal
  const [gdocOpen, setGdocOpen] = useState(false);

  // ----- Hydrate from sessionStorage on mount -----
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const persisted = loadWizardState();
    if (persisted) {
      setStep(persisted.step);
      setRows(persisted.rows.length > 0 ? persisted.rows : [makeRow()]);
      setVoState(new Map(persisted.voState));
      // Sanitize lipsyncState: any "running" entry without a batchId
      // came from a previous session whose in-memory poller died on
      // unload — there's no way to recover it, so demote to "idle" so
      // the user can retry. Running entries WITH a batchId are kept
      // (the resume effect below will spin up fresh pollers for them).
      const sanitized = new Map<string, LsCellState>();
      for (const [id, s] of persisted.lipsyncState) {
        if (s.status === "running" && !s.batchId) {
          sanitized.set(id, { status: "idle" });
        } else {
          sanitized.set(id, s);
        }
      }
      setLipsyncState(sanitized);
      // Rehydrate briefs map from localStorage by id.
      const all = loadBriefs();
      const m = new Map<string, Brief>();
      for (const r of persisted.rows) {
        if (r.briefId) {
          const b = all.find((x) => x.id === r.briefId);
          if (b) m.set(b.id, b);
        }
      }
      setBriefs(m);
    }
  }, []);

  // ----- Resume polling for jobs that were "running" with a known
  // batchId when the page was last unloaded. Runs once briefs are
  // hydrated so we have the (briefId, hookId, avatarId) to write back
  // into when the job completes.
  const resumedPollers = useRef(false);
  useEffect(() => {
    if (!hydrated.current || resumedPollers.current) return;
    if (briefs.size === 0) return; // wait for briefs hydration
    resumedPollers.current = true;
    for (const [id, s] of lipsyncState) {
      if (s.status !== "running" || !s.batchId) continue;
      const [briefId, hookId, avatarId] = id.split(":");
      if (!briefId || !hookId || !avatarId) continue;
      void startLsPolling(id, s.batchId, briefId, hookId, avatarId);
    }
    // Intentionally not in deps: this should fire exactly once after
    // first briefs hydration, not every time lipsyncState changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefs.size]);

  // ----- Persist on changes (debounced via microtask) -----
  useEffect(() => {
    if (!hydrated.current) return;
    saveWizardState({
      step,
      rows,
      voState: Array.from(voState.entries()),
      lipsyncState: Array.from(lipsyncState.entries()),
    });
  }, [step, rows, voState, lipsyncState]);

  // ----- Refresh briefs map from localStorage on focus -----
  // /cut-silence may have written a cleaned URL into a hook's cutVoUrl
  // while the user was navigated away. We refresh both the briefs map
  // AND the in-memory voState URLs so the audio player picks up the
  // new file without needing a hard reload.
  useEffect(() => {
    const refresh = () => {
      const all = loadBriefs();
      const fresh = new Map<string, Brief>();
      setBriefs((prev) => {
        for (const [id] of prev) {
          const b = all.find((x) => x.id === id);
          if (b) fresh.set(id, b);
        }
        return fresh;
      });
      // Sync voState entries with the new hook.cutVoUrl values so the
      // render's `h.cutVoUrl || s?.url` precedence always agrees with
      // localStorage.
      setVoState((prev) => {
        const nm = new Map(prev);
        for (const [id, brief] of fresh) {
          for (const h of brief.hooks) {
            if (!h.cutVoUrl) continue;
            const key = `${id}:${h.id}`;
            const existing = nm.get(key);
            if (existing?.url !== h.cutVoUrl) {
              nm.set(key, { status: "done", url: h.cutVoUrl });
            }
          }
        }
        return nm;
      });
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  // ----- Fetch voices once -----
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/voiceover/voices");
        const data = (await r.json()) as { voices?: Voice[] };
        if (data.voices) {
          setVoices(data.voices);
          const fav = FAVORITE_VOICE_IDS.find((id) =>
            data.voices!.some((v) => v.voiceId === id),
          );
          setVoiceId(fav || data.voices[0]?.voiceId || "");
        }
      } catch {
        /* offline */
      }
    })();
  }, []);

  // -----------------------------------------------------------------------
  // Step 1 — Briefs
  // -----------------------------------------------------------------------

  const addRow = useCallback(() => {
    setRows((rs) => [...rs, makeRow()]);
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.rowId !== id) : rs));
  }, []);

  const patchRow = useCallback((id: string, patch: Partial<DraftRow>) => {
    setRows((rs) => rs.map((r) => (r.rowId === id ? { ...r, ...patch } : r)));
  }, []);

  // Fired by the Google Doc import modal — created briefs are already in
  // localStorage, so we just need to push matching DraftRows and jump to
  // Step 3 (VO) since scripts are already filled.
  const onGdocImported = useCallback((created: Brief[]) => {
    if (created.length === 0) return;
    const nextRows: DraftRow[] = created.map((b) => ({
      rowId: Math.random().toString(36).slice(2, 10),
      briefName: parseBriefName(b.adsetName).briefName,
      creativeName: parseBriefName(b.adsetName).creativeName,
      avatarCount: b.avatarCount,
      briefId: b.id,
    }));
    setRows(nextRows);
    setBriefs((m) => {
      const nm = new Map(m);
      for (const b of created) nm.set(b.id, b);
      return nm;
    });
    setGdocOpen(false);
    // Scripts are already in. Jump to VO so the user can immediately start
    // generating voices — the whole "type each name + paste each script"
    // loop is skipped.
    setStep(3);
  }, []);

  const commitBriefs = useCallback((): { ok: number; skipped: number } => {
    const nextBriefs = new Map(briefs);
    const nextRows: DraftRow[] = [];
    let ok = 0;
    let skipped = 0;
    for (const r of rows) {
      const briefName = r.briefName.trim();
      const creativeName = r.creativeName.trim();
      if (!briefName && !creativeName) {
        skipped++;
        continue;
      }
      if (r.briefId && nextBriefs.has(r.briefId)) {
        nextRows.push(r);
        ok++;
        continue;
      }
      const adsetName = composeAdsetName(briefName, creativeName);
      const b = newBrief({ avatarCount: r.avatarCount, adsetName });
      upsertBrief(b);
      nextBriefs.set(b.id, b);
      nextRows.push({ ...r, briefId: b.id });
      ok++;
    }
    setBriefs(nextBriefs);
    setRows(nextRows.length > 0 ? nextRows : [makeRow()]);
    return { ok, skipped };
  }, [briefs, rows]);

  // -----------------------------------------------------------------------
  // Step 2 — Scripts + optional notes + creative ref
  // -----------------------------------------------------------------------

  const updateHookField = useCallback(
    (
      briefId: string,
      hookId: string,
      patch: { hookScript?: string; notes?: string; aiInstructions?: string },
    ) => {
      const brief = briefs.get(briefId);
      if (!brief) return;
      const next: Brief = {
        ...brief,
        hooks: brief.hooks.map((h) => (h.id === hookId ? { ...h, ...patch } : h)),
      };
      const saved = upsertBrief(next);
      setBriefs((m) => {
        const nm = new Map(m);
        nm.set(briefId, saved);
        return nm;
      });
    },
    [briefs],
  );

  const updateBriefField = useCallback(
    (briefId: string, patch: { creativeRef?: string; notes?: string }) => {
      const brief = briefs.get(briefId);
      if (!brief) return;
      const next: Brief = { ...brief, ...patch };
      const saved = upsertBrief(next);
      setBriefs((m) => {
        const nm = new Map(m);
        nm.set(briefId, saved);
        return nm;
      });
    },
    [briefs],
  );

  // -----------------------------------------------------------------------
  // Step 3 — Voice-over batch
  // -----------------------------------------------------------------------

  const voJobs = useMemo((): VoBatchJob[] => {
    const jobs: VoBatchJob[] = [];
    if (!voiceId) return jobs;
    const voiceName = voices.find((v) => v.voiceId === voiceId)?.name;
    for (const r of rows) {
      if (!r.briefId) continue;
      const brief = briefs.get(r.briefId);
      if (!brief) continue;
      for (const h of brief.hooks) {
        if (!h.hookScript.trim()) continue;
        const id = `${brief.id}:${h.id}`;
        const existing = voState.get(id);
        if (existing?.status === "done" || h.cutVoUrl) continue;
        jobs.push({
          id,
          voiceId,
          voiceName,
          text: h.hookScript.trim(),
          modelId: voModelId,
        });
      }
    }
    return jobs;
  }, [briefs, rows, voState, voiceId, voices, voModelId]);

  const runBatchVo = useCallback(async () => {
    if (voJobs.length === 0) return;
    voAbortRef.current?.abort();
    const ac = new AbortController();
    voAbortRef.current = ac;

    setVoState((s) => {
      const nm = new Map(s);
      for (const j of voJobs) nm.set(j.id, { status: "running" });
      return nm;
    });

    await runVoiceoverBatch(
      voJobs,
      (e) => {
        if (e.kind === "start") {
          setVoState((s) => {
            const nm = new Map(s);
            nm.set(e.id, { status: "running" });
            return nm;
          });
          return;
        }
        if (e.ok) {
          const [briefId, hookId] = e.id.split(":");
          const brief = briefs.get(briefId);
          if (brief) {
            const next: Brief = {
              ...brief,
              hooks: brief.hooks.map((h) =>
                h.id === hookId ? { ...h, cutVoUrl: e.url } : h,
              ),
            };
            const saved = upsertBrief(next);
            setBriefs((m) => {
              const nm = new Map(m);
              nm.set(briefId, saved);
              return nm;
            });
          }
          setVoState((s) => {
            const nm = new Map(s);
            nm.set(e.id, { status: "done", url: e.url });
            return nm;
          });
        } else {
          setVoState((s) => {
            const nm = new Map(s);
            nm.set(e.id, { status: "error", error: e.error });
            return nm;
          });
        }
      },
      { concurrency: 4, signal: ac.signal },
    );
  }, [briefs, voJobs]);

  const cancelBatchVo = useCallback(() => {
    voAbortRef.current?.abort();
    setVoState((s) => {
      const nm = new Map(s);
      for (const [id, v] of nm) {
        if (v.status === "running") nm.set(id, { status: "idle" });
      }
      return nm;
    });
  }, []);

  const regenerateVo = useCallback(
    async (briefId: string, hookId: string) => {
      const brief = briefs.get(briefId);
      if (!brief) return;
      const hook = brief.hooks.find((h) => h.id === hookId);
      if (!hook || !hook.hookScript.trim() || !voiceId) return;
      const voiceName = voices.find((v) => v.voiceId === voiceId)?.name;
      const id = `${briefId}:${hookId}`;
      setVoState((s) => {
        const nm = new Map(s);
        nm.set(id, { status: "running" });
        return nm;
      });
      try {
        const r = await fetch("/api/voiceover/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            voiceId,
            voiceName,
            text: hook.hookScript.trim(),
            modelId: voModelId,
          }),
        });
        const data = (await r.json()) as { url?: string; error?: string };
        if (!r.ok || !data.url) {
          setVoState((s) => {
            const nm = new Map(s);
            nm.set(id, { status: "error", error: data.error || `HTTP ${r.status}` });
            return nm;
          });
          return;
        }
        const next: Brief = {
          ...brief,
          hooks: brief.hooks.map((h) =>
            h.id === hookId ? { ...h, cutVoUrl: data.url } : h,
          ),
        };
        const saved = upsertBrief(next);
        setBriefs((m) => {
          const nm = new Map(m);
          nm.set(briefId, saved);
          return nm;
        });
        setVoState((s) => {
          const nm = new Map(s);
          nm.set(id, { status: "done", url: data.url });
          return nm;
        });
      } catch (e) {
        setVoState((s) => {
          const nm = new Map(s);
          nm.set(id, { status: "error", error: e instanceof Error ? e.message : String(e) });
          return nm;
        });
      }
    },
    [briefs, voiceId, voices, voModelId],
  );

  // Cut-blanks handoff. Stores the audio URL + sets attach target then
  // navigates to /cut-silence. The studio reads the handoff, lets the user
  // cut, then writes the cleaned URL back into the brief.cutVoUrl. The
  // sessionStorage `pf:cutSilenceReturnTo` tells the studio to send the
  // user back here instead of into the per-brief wizard.
  const handoffCut = useCallback(
    (briefId: string, hookId: string, audioUrl: string) => {
      if (typeof window === "undefined") return;
      window.sessionStorage.setItem(
        "pf:cutSilenceHandoff",
        JSON.stringify({ audioUrl, fileName: `${briefId}_${hookId}.mp3` }),
      );
      window.sessionStorage.setItem("pf:cutSilenceReturnTo", "/briefs/batch");
      setAttachTarget({ kind: "cutVo", briefId, hookId });
      router.push("/cut-silence");
    },
    [router],
  );

  // Step 4 quick action: clone hook.cutVoUrl into every avatar's
  // voClipUrl (when the avatar doesn't already have one). 9 times out
  // of 10 the user wants the same VO across all avatars of a hook —
  // this skips the manual per-avatar attach.
  const useHookVoForAvatars = useCallback(
    (briefId: string) => {
      const brief = briefs.get(briefId);
      if (!brief) return;
      const next: Brief = {
        ...brief,
        hooks: brief.hooks.map((h) => {
          if (!h.cutVoUrl) return h;
          return {
            ...h,
            avatars: h.avatars.map((a) =>
              a.voClipUrl
                ? a
                : { ...a, voClipUrl: h.cutVoUrl, voClipText: h.hookScript || a.voClipText },
            ),
          };
        }),
      };
      const saved = upsertBrief(next);
      setBriefs((m) => {
        const nm = new Map(m);
        nm.set(briefId, saved);
        return nm;
      });
    },
    [briefs],
  );

  // Step 2 (Avatars) handler — adjust avatar count for a single hook.
  // Uses safeResizeHookAvatars so that any already-attached image / VO
  // clip / lipsync video survives a count change. The user can therefore
  // come back to Step 2 mid-batch and tweak counts without losing work.
  const setHookAvatarCount = useCallback(
    (briefId: string, hookId: string, target: number) => {
      const brief = briefs.get(briefId);
      if (!brief) return;
      const next: Brief = {
        ...brief,
        hooks: brief.hooks.map((h) =>
          h.id === hookId ? safeResizeHookAvatars(h, target) : h,
        ),
      };
      // Keep brief.avatarCount in sync with the max across hooks so the
      // single-brief wizard's avatar slider lands on a sensible value.
      const maxCount = next.hooks.reduce(
        (acc, h) => Math.max(acc, h.avatars.length),
        0,
      );
      next.avatarCount = maxCount;
      const saved = upsertBrief(next);
      setBriefs((m) => {
        const nm = new Map(m);
        nm.set(briefId, saved);
        return nm;
      });
    },
    [briefs],
  );

  // Step 5 (Images) — direct per-avatar handlers used by the new list
  // view. They delegate to lib/briefs applyAttach / clearAttach so the
  // exact same semantics as the universal AttachToBriefButton apply.
  // After every mutation we sync the local briefs Map so the row's
  // thumbnail / fill state updates in-place without a router refresh.
  const uploadImageToAvatar = useCallback(
    async (briefId: string, hookId: string, avatarId: string, file: File) => {
      const url = await uploadFileToStorage(file);
      const updated = applyAttach(
        { kind: "avatarImage", briefId, hookId, avatarId },
        { url },
      );
      if (updated) {
        setBriefs((m) => {
          const nm = new Map(m);
          nm.set(briefId, updated);
          return nm;
        });
      }
    },
    [],
  );

  const clearAvatarImage = useCallback(
    (briefId: string, hookId: string, avatarId: string) => {
      const updated = clearAttach({
        kind: "avatarImage",
        briefId,
        hookId,
        avatarId,
      });
      if (updated) {
        setBriefs((m) => {
          const nm = new Map(m);
          nm.set(briefId, updated);
          return nm;
        });
      }
    },
    [],
  );

  // Same pattern as the image handlers above, for the per-avatar voice
  // clip (avatar.voClipUrl). Audio MIME types are accepted by /api/upload
  // already, so the same endpoint works for both flows.
  const uploadVoToAvatar = useCallback(
    async (briefId: string, hookId: string, avatarId: string, file: File) => {
      const url = await uploadFileToStorage(file);
      const updated = applyAttach(
        { kind: "avatarClip", briefId, hookId, avatarId },
        { url, text: file.name },
      );
      if (updated) {
        setBriefs((m) => {
          const nm = new Map(m);
          nm.set(briefId, updated);
          return nm;
        });
      }
    },
    [],
  );

  const clearAvatarVo = useCallback(
    (briefId: string, hookId: string, avatarId: string) => {
      const updated = clearAttach({
        kind: "avatarClip",
        briefId,
        hookId,
        avatarId,
      });
      if (updated) {
        setBriefs((m) => {
          const nm = new Map(m);
          nm.set(briefId, updated);
          return nm;
        });
      }
    },
    [],
  );

  // Per-avatar variant of useHookVoForAvatars: copies just THIS avatar's
  // voClipUrl from its hook.cutVoUrl. No-op if the hook has no VO. Does
  // not check whether the avatar already has a clip — the button is
  // labeled "VO du hook" so the user explicitly opts in to overwrite.
  const useHookVoForOneAvatar = useCallback(
    (briefId: string, hookId: string, avatarId: string) => {
      const brief = briefs.get(briefId);
      if (!brief) return;
      const hook = brief.hooks.find((h) => h.id === hookId);
      if (!hook?.cutVoUrl) return;
      const updated = applyAttach(
        { kind: "avatarClip", briefId, hookId, avatarId },
        { url: hook.cutVoUrl, text: hook.hookScript || undefined },
      );
      if (updated) {
        setBriefs((m) => {
          const nm = new Map(m);
          nm.set(briefId, updated);
          return nm;
        });
      }
    },
    [briefs],
  );

  // -----------------------------------------------------------------------
  // Step 6 — Lipsync batch
  // -----------------------------------------------------------------------

  type LipsyncJob = {
    id: string; // briefId:hookId:avatarId
    briefId: string;
    hookId: string;
    avatar: AvatarSlot;
  };

  const lipsyncJobs = useMemo((): LipsyncJob[] => {
    const jobs: LipsyncJob[] = [];
    for (const r of rows) {
      if (!r.briefId) continue;
      const brief = briefs.get(r.briefId);
      if (!brief || !briefHasAvatars(brief)) continue;
      for (const h of brief.hooks) {
        for (const av of h.avatars) {
          if (!av.imageUrl || !av.voClipUrl) continue;
          if (av.lipsyncStatus === "done" && av.lipsyncVideoUrl) continue;
          const id = `${brief.id}:${h.id}:${av.id}`;
          const s = lipsyncState.get(id);
          if (s?.status === "done" || s?.status === "running") continue;
          jobs.push({ id, briefId: brief.id, hookId: h.id, avatar: av });
        }
      }
    }
    return jobs;
  }, [briefs, rows, lipsyncState]);

  const stopLsPolling = useCallback((id: string) => {
    const t = lsPollersRef.current.get(id);
    if (t) {
      clearInterval(t);
      lsPollersRef.current.delete(id);
    }
  }, []);

  // Wraps a polling loop in a Promise that resolves the moment the Kling
  // job lands in a terminal state (done OR failed). This is what makes
  // runLipsyncBatch's "wave of 2" model work: a wave only advances when
  // BOTH jobs in it have actually completed, not just when their POSTs
  // returned.
  const startLsPolling = useCallback(
    (
      id: string,
      batchId: string,
      briefId: string,
      hookId: string,
      avatarId: string,
    ): Promise<void> => {
      return new Promise<void>((resolve) => {
        stopLsPolling(id);
        const finish = () => {
          stopLsPolling(id);
          resolve();
        };
        const poll = async () => {
          try {
            const r = await fetch(`/api/batch/${batchId}/status`, { cache: "no-store" });
            if (!r.ok) return;
            const data = (await r.json()) as {
              items?: Array<{
                status: string;
                output_url?: string | null;
                error?: string | null;
              }>;
            };
            const item = data.items?.[0];
            if (!item) return;
            if (item.status === "done" && item.output_url) {
              const brief = briefs.get(briefId);
              if (brief) {
                const next: Brief = {
                  ...brief,
                  hooks: brief.hooks.map((h) =>
                    h.id === hookId
                      ? {
                          ...h,
                          avatars: h.avatars.map((a) =>
                            a.id === avatarId
                              ? {
                                  ...a,
                                  lipsyncStatus: "done",
                                  lipsyncVideoUrl: item.output_url || undefined,
                                }
                              : a,
                          ),
                        }
                      : h,
                  ),
                };
                const saved = upsertBrief(next);
                setBriefs((m) => {
                  const nm = new Map(m);
                  nm.set(briefId, saved);
                  return nm;
                });
              }
              setLipsyncState((s) => {
                const nm = new Map(s);
                nm.set(id, { status: "done", url: item.output_url || undefined });
                return nm;
              });
              finish();
            } else if (item.status === "failed") {
              setLipsyncState((s) => {
                const nm = new Map(s);
                nm.set(id, { status: "error", error: item.error || "Kling failed" });
                return nm;
              });
              finish();
            }
          } catch {
            /* blip — keep polling */
          }
        };
        const i = setInterval(poll, 6000);
        lsPollersRef.current.set(id, i);
        void poll();
      });
    },
    [briefs, stopLsPolling],
  );

  const runOneLipsync = useCallback(
    async (job: LipsyncJob) => {
      setLipsyncState((s) => {
        const nm = new Map(s);
        nm.set(job.id, { status: "running" });
        return nm;
      });
      try {
        // Decode audio duration client-side (the API needs it).
        let audioDurationSec = 10;
        try {
          const resp = await fetch(job.avatar.voClipUrl!);
          const buf = await resp.arrayBuffer();
          const Ctx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext })
              .webkitAudioContext;
          const ctx = new Ctx();
          const decoded = await ctx.decodeAudioData(buf);
          audioDurationSec = decoded.duration;
          await ctx.close();
        } catch {
          /* fallback to 10s */
        }
        const r = await fetch("/api/lipsync/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageUrl: job.avatar.imageUrl,
            audioUrl: job.avatar.voClipUrl,
            prompt:
              job.avatar.lipsyncPrompt ||
              "Locked gaze: he maintains direct eye contact with the camera for the entire clip, never glancing to the side. The video plan must not move; it must remain fixed.",
            modelKey: "kling-avatars-2",
            qualityLabel: job.avatar.lipsyncQuality || "Pro",
            audioDurationSec,
          }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
        // Stash the batch_id alongside "running" so a page reload can
        // resume polling instead of leaving the row stuck forever.
        setLipsyncState((s) => {
          const nm = new Map(s);
          nm.set(job.id, { status: "running", batchId: data.batch_id });
          return nm;
        });
        // Block until polling reports a terminal state — required so
        // the sequential queue can advance correctly.
        await startLsPolling(
          job.id,
          data.batch_id,
          job.briefId,
          job.hookId,
          job.avatar.id,
        );
      } catch (e) {
        setLipsyncState((s) => {
          const nm = new Map(s);
          nm.set(job.id, { status: "error", error: e instanceof Error ? e.message : String(e) });
          return nm;
        });
      }
    },
    [startLsPolling],
  );

  // Strict sequential queue (one lipsync at a time). Replaces the older
  // waves-of-2 runner. The user explicitly asked for "une par une" so
  // they can verify each generated video before the next one starts.
  // Per-row Generate buttons (triggerOneLipsync) sit alongside this for
  // full manual control.
  const runLipsyncBatch = useCallback(async () => {
    if (lipsyncJobs.length === 0) return;
    lsAbortRef.current?.abort();
    const ac = new AbortController();
    lsAbortRef.current = ac;
    for (const job of lipsyncJobs) {
      if (ac.signal.aborted) break;
      await runOneLipsync(job);
    }
  }, [lipsyncJobs, runOneLipsync]);

  const cancelLipsyncBatch = useCallback(() => {
    lsAbortRef.current?.abort();
    // Note: in-flight polling continues — Kling jobs keep running on their side.
  }, []);

  // Manual one-shot trigger for the per-row "Générer ce lipsync" button.
  // Resolves the (briefId, hookId, avatarId) into a LipsyncJob and runs
  // exactly one job. Refuses if the slot is missing image or VO clip.
  const triggerOneLipsync = useCallback(
    async (briefId: string, hookId: string, avatarId: string) => {
      const brief = briefs.get(briefId);
      if (!brief) return;
      const hook = brief.hooks.find((h) => h.id === hookId);
      const avatar = hook?.avatars.find((a) => a.id === avatarId);
      if (!hook || !avatar) return;
      if (!avatar.imageUrl || !avatar.voClipUrl) return;
      await runOneLipsync({
        id: `${briefId}:${hookId}:${avatarId}`,
        briefId,
        hookId,
        avatar,
      });
    },
    [briefs, runOneLipsync],
  );

  // Manual "unstick" — clear a row that's reported "running" but is
  // actually orphaned (in-memory poller died and Kling didn't write
  // back, or the user wants to retry from scratch). Kills the local
  // setInterval if any, then drops the entry from lipsyncState so the
  // row falls back to "Prête à générer".
  const resetOneLipsync = useCallback(
    (briefId: string, hookId: string, avatarId: string) => {
      const id = `${briefId}:${hookId}:${avatarId}`;
      stopLsPolling(id);
      setLipsyncState((s) => {
        const nm = new Map(s);
        nm.delete(id);
        return nm;
      });
    },
    [stopLsPolling],
  );

  // -----------------------------------------------------------------------
  // Step 6 — Notion sync
  // -----------------------------------------------------------------------

  const syncOne = useCallback(async (brief: Brief) => {
    setSyncState((s) => {
      const nm = new Map(s);
      nm.set(brief.id, { status: "running" });
      return nm;
    });
    try {
      const r = await fetch("/api/notion/sync-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief }),
      });
      const data = (await r.json()) as {
        pages?: Array<{ hookId: string; pageId: string; url: string; error?: string }>;
        error?: string;
      };
      if (!r.ok || data.error) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      const firstUrl = data.pages?.find((p) => p.url)?.url;
      setSyncState((s) => {
        const nm = new Map(s);
        nm.set(brief.id, { status: "done", url: firstUrl });
        return nm;
      });
    } catch (e) {
      setSyncState((s) => {
        const nm = new Map(s);
        nm.set(brief.id, {
          status: "error",
          error: e instanceof Error ? e.message : String(e),
        });
        return nm;
      });
    }
  }, []);

  const syncAll = useCallback(async () => {
    const list = Array.from(briefs.values());
    const concurrency = 3;
    let i = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (i < list.length) {
        const idx = i++;
        await syncOne(list[idx]);
      }
    });
    await Promise.all(workers);
  }, [briefs, syncOne]);

  // -----------------------------------------------------------------------
  // Derived
  // -----------------------------------------------------------------------

  const committedBriefs = useMemo(
    () =>
      rows
        .filter((r) => r.briefId)
        .map((r) => briefs.get(r.briefId!))
        .filter((b): b is Brief => !!b),
    [briefs, rows],
  );

  const hasAvatars = useMemo(
    () => committedBriefs.some(briefHasAvatars),
    [committedBriefs],
  );

  // -----------------------------------------------------------------------
  // Step navigation
  // -----------------------------------------------------------------------

  const maxStep: StepId = 7;
  const goNext = useCallback(() => {
    if (step === 1) {
      const { ok } = commitBriefs();
      if (ok === 0) return;
      setStep(2);
      return;
    }
    setStep((s) => Math.min(maxStep, s + 1) as StepId);
  }, [commitBriefs, step]);

  const goBack = useCallback(() => {
    setStep((s) => Math.max(1, s - 1) as StepId);
  }, []);

  // Auto-skip Images (5) + Lipsync (6) when no brief uses avatars. The
  // user lands on Sync (7) instead. The Avatars step (2) is never
  // auto-skipped — it's where the user PICKS whether to add avatars.
  useEffect(() => {
    if ((step === 5 || step === 6) && committedBriefs.length > 0 && !hasAvatars) {
      setStep(7);
    }
  }, [step, committedBriefs, hasAvatars]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="space-y-6 text-[15px] pb-32">
      <Stepper step={step} onPick={setStep} hasAvatars={hasAvatars} />

      <div key={step} className="pf-fade-in min-h-[480px]">
        {step === 1 && (
          <Step1Briefs
            rows={rows}
            onAdd={addRow}
            onRemove={removeRow}
            onPatch={patchRow}
            onOpenGdoc={() => setGdocOpen(true)}
          />
        )}
        {step === 2 && (
          <Step2Avatars briefs={committedBriefs} onSetAvatarCount={setHookAvatarCount} />
        )}
        {step === 3 && (
          <Step3Scripts
            briefs={committedBriefs}
            onUpdateHook={updateHookField}
            onUpdateBrief={updateBriefField}
          />
        )}
        {step === 4 && (
          <Step4Voiceover
            briefs={committedBriefs}
            voices={voices}
            voiceId={voiceId}
            onVoiceChange={setVoiceId}
            modelId={voModelId}
            onModelChange={setVoModelId}
            voState={voState}
            onRunAll={runBatchVo}
            onCancel={cancelBatchVo}
            onRegenerate={regenerateVo}
            onCutBlanks={handoffCut}
            pendingCount={voJobs.length}
          />
        )}
        {step === 5 && (
          <Step5Images
            briefs={committedBriefs}
            onOpenBrief={(id) => router.push(`/briefs/${id}`)}
            onUseHookVoForAvatars={useHookVoForAvatars}
            onUploadImageToAvatar={uploadImageToAvatar}
            onClearAvatarImage={clearAvatarImage}
            onUploadVoToAvatar={uploadVoToAvatar}
            onClearAvatarVo={clearAvatarVo}
            onUseHookVoForOneAvatar={useHookVoForOneAvatar}
          />
        )}
        {step === 6 && (
          <Step6Lipsync
            briefs={committedBriefs}
            lipsyncState={lipsyncState}
            onRunAll={runLipsyncBatch}
            onCancel={cancelLipsyncBatch}
            onTriggerOne={triggerOneLipsync}
            onResetOne={resetOneLipsync}
            pendingCount={lipsyncJobs.length}
            anyRunning={Array.from(lipsyncState.values()).some((s) => s.status === "running")}
            onOpenBrief={(id) => router.push(`/briefs/${id}`)}
          />
        )}
        {step === 7 && (
          <Step7Sync
            briefs={committedBriefs}
            syncState={syncState}
            onSyncAll={syncAll}
            onSyncOne={syncOne}
            voState={voState}
            lipsyncState={lipsyncState}
          />
        )}
      </div>

      {/* Google Doc import modal */}
      {gdocOpen && (
        <GdocImportModal
          onClose={() => setGdocOpen(false)}
          onImported={onGdocImported}
        />
      )}

      {/* Sticky bottom nav */}
      <div className="sticky bottom-4 z-10 bg-pf-bg/95 backdrop-blur-md border border-pf-border rounded-2xl px-5 py-3.5 flex items-center justify-between shadow-xl shadow-black/40">
        <button
          type="button"
          onClick={goBack}
          disabled={step === 1}
          className="inline-flex items-center gap-2 text-sm text-pf-dim hover:text-pf-text px-3.5 py-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowLeft size={15} />
          Précédent
        </button>

        <div className="text-sm text-pf-muted">
          Étape <span className="text-pf-text font-semibold">{step}</span> / {maxStep}
        </div>

        {step < maxStep ? (
          <button
            type="button"
            onClick={goNext}
            disabled={
              step === 1 &&
              rows.every((r) => !r.briefName.trim() && !r.creativeName.trim())
            }
            className="inline-flex items-center gap-2 bg-pf-accent text-pf-accent-fg font-bold rounded-xl px-5 py-2.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-pf-accent/90 transition-colors"
          >
            {step === 1
              ? `Valider (${rows.filter((r) => r.briefName.trim() || r.creativeName.trim()).length})`
              : "Suivant"}
            <ArrowRight size={15} />
          </button>
        ) : (
          <Link
            href="/briefs"
            className="inline-flex items-center gap-2 bg-pf-soft border border-pf-border hover:border-pf-accent rounded-xl px-5 py-2.5 text-sm font-semibold transition-colors"
          >
            Terminer
            <Check size={15} />
          </Link>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Stepper — top tabs
// ===========================================================================

function Stepper({
  step,
  onPick,
  hasAvatars,
}: {
  step: StepId;
  onPick: (s: StepId) => void;
  hasAvatars: boolean;
}) {
  const items: { id: StepId; label: string; subtitle: string }[] = [
    { id: 1, label: "Briefs", subtitle: "Nom + créa" },
    { id: 2, label: "Avatars", subtitle: "Par hook (0-10)" },
    { id: 3, label: "Scripts", subtitle: "V1 + N hooks" },
    { id: 4, label: "Voix off", subtitle: "Bulk + cut" },
    { id: 5, label: "Images", subtitle: hasAvatars ? "Par avatar" : "Skippé" },
    { id: 6, label: "Lipsync", subtitle: hasAvatars ? "Bulk Kling" : "Skippé" },
    { id: 7, label: "Sync", subtitle: "Notion" },
  ];
  return (
    <div className="bg-pf-elev border border-pf-border rounded-2xl px-2 py-2">
      <div className="flex items-stretch gap-1">
        {items.map((it, i) => {
          const active = step === it.id;
          const done = step > it.id;
          const skipped = (it.id === 5 || it.id === 6) && !hasAvatars;
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => onPick(it.id)}
              disabled={skipped}
              className={`flex-1 flex items-center gap-2.5 px-3 py-2.5 rounded-xl transition-colors text-left ${
                active
                  ? "bg-pf-accent/15 text-pf-text"
                  : done
                    ? "text-pf-text hover:bg-pf-soft"
                    : skipped
                      ? "opacity-30 cursor-not-allowed"
                      : "text-pf-dim hover:bg-pf-soft hover:text-pf-text"
              }`}
            >
              <span
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
                  active
                    ? "bg-pf-accent text-pf-accent-fg"
                    : done
                      ? "bg-pf-ok/20 text-pf-ok border border-pf-ok/40"
                      : "bg-pf-soft border border-pf-border text-pf-muted"
                }`}
              >
                {done ? <Check size={14} /> : i + 1}
              </span>
              <div className="min-w-0 hidden md:block">
                <div className="text-sm font-semibold leading-tight truncate">{it.label}</div>
                <div className="text-xs text-pf-muted leading-tight truncate">{it.subtitle}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ===========================================================================
// Step 1 — Briefs (multi-add)
// ===========================================================================

function Step1Briefs({
  rows,
  onAdd,
  onRemove,
  onPatch,
  onOpenGdoc,
}: {
  rows: DraftRow[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  onPatch: (id: string, patch: Partial<DraftRow>) => void;
  onOpenGdoc: () => void;
}) {
  const lastCreativeRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-5">
      <Intro
        title="Liste tes briefs pour la semaine"
        body="Une ligne = un brief = 3 vidéos (V1 + 2 hooks). Le nom du brief + le nom de la créa formeront le titre. Avatars IA : 0 si pas besoin."
      />

      {/* Google Doc import shortcut — the fastest path. */}
      <button
        type="button"
        onClick={onOpenGdoc}
        className="w-full bg-gradient-to-br from-pf-accent/15 via-pf-accent/5 to-transparent border border-pf-accent/40 hover:border-pf-accent rounded-2xl p-5 flex items-center gap-4 text-left transition-colors group"
      >
        <div className="w-12 h-12 rounded-xl bg-pf-accent/20 border border-pf-accent/40 text-pf-accent flex items-center justify-center shrink-0">
          <ClipboardPaste size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-base font-bold mb-0.5">
            Importer depuis un Google Doc
          </div>
          <p className="text-sm text-pf-dim leading-relaxed">
            Colle ton doc complet → on crée TOUS les briefs + scripts + hooks +
            ref en un coup. Tu passes direct à l&apos;étape Voix off.
          </p>
        </div>
        <ArrowRight
          size={18}
          className="text-pf-accent shrink-0 group-hover:translate-x-1 transition-transform"
        />
      </button>

      <div className="text-center text-xs text-pf-muted uppercase tracking-wider font-semibold">
        — ou saisis manuellement —
      </div>

      <div className="bg-pf-elev border border-pf-border rounded-2xl divide-y divide-pf-border overflow-hidden">
        <div className="grid grid-cols-[1fr_1.4fr_140px_48px] gap-4 px-5 py-3 bg-pf-soft text-xs uppercase tracking-wider text-pf-muted font-bold">
          <span>Nom du brief</span>
          <span>Nom de la créa</span>
          <span>Avatars IA</span>
          <span className="text-right"></span>
        </div>
        {rows.map((r, i) => {
          const isLast = i === rows.length - 1;
          return (
            <div
              key={r.rowId}
              className="grid grid-cols-[1fr_1.4fr_140px_48px] gap-4 px-5 py-3 items-center"
            >
              <input
                type="text"
                value={r.briefName}
                onChange={(e) => onPatch(r.rowId, { briefName: e.target.value })}
                placeholder={`Ad Test #${i + 1}`}
                className="bg-pf-bg border border-pf-border rounded-lg px-3 py-2.5 text-base focus:outline-none focus:border-pf-accent"
              />
              <input
                ref={isLast ? lastCreativeRef : undefined}
                type="text"
                value={r.creativeName}
                onChange={(e) => onPatch(r.rowId, { creativeName: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onAdd();
                    setTimeout(() => lastCreativeRef.current?.focus(), 0);
                  }
                }}
                placeholder="Anti-Fake Dermato"
                className="bg-pf-bg border border-pf-border rounded-lg px-3 py-2.5 text-base focus:outline-none focus:border-pf-accent"
              />
              <AvatarCountPicker
                value={r.avatarCount}
                onChange={(n) => onPatch(r.rowId, { avatarCount: n })}
              />
              <button
                type="button"
                onClick={() => onRemove(r.rowId)}
                className="text-pf-muted hover:text-pf-danger w-10 h-10 rounded-lg flex items-center justify-center hover:bg-pf-soft transition-colors"
                aria-label="Retirer la ligne"
              >
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onAdd}
        className="w-full bg-pf-elev border border-dashed border-pf-border hover:border-pf-accent rounded-2xl px-4 py-4 text-base text-pf-dim hover:text-pf-text flex items-center justify-center gap-2 transition-colors"
      >
        <Plus size={16} />
        Ajouter un brief
      </button>

      <div className="text-sm text-pf-muted text-center">
        Astuce :{" "}
        <kbd className="px-2 py-0.5 bg-pf-soft border border-pf-border rounded text-xs">
          Entrée
        </kbd>{" "}
        dans le champ « créa » ajoute automatiquement une nouvelle ligne.
      </div>
    </div>
  );
}

function AvatarCountPicker({
  value,
  onChange,
  max = MAX_AVATARS_PER_HOOK,
}: {
  value: number;
  onChange: (n: number) => void;
  max?: number;
}) {
  return (
    <div className="flex items-center gap-1 bg-pf-bg border border-pf-border rounded-lg p-1">
      <button
        type="button"
        onClick={() => onChange(Math.max(0, value - 1))}
        disabled={value <= 0}
        className="w-8 h-8 rounded-md text-pf-muted hover:text-pf-text hover:bg-pf-soft flex items-center justify-center text-lg disabled:opacity-30"
      >
        −
      </button>
      <span className="font-mono text-lg font-bold w-8 text-center text-pf-text">
        {value}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        className="w-8 h-8 rounded-md text-pf-muted hover:text-pf-text hover:bg-pf-soft flex items-center justify-center text-lg disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}

// ===========================================================================
// Step 2 — Avatars (per-hook avatar count picker, 0..10)
//
// Sits between Briefs (step 1) and Scripts (step 3). For each committed
// brief, lists every hook (V1, H2, H3, … up to N detected from the doc)
// with a +/− picker bound to safeResizeHookAvatars in the parent.
// Editing here mid-batch is safe: filled slots (image/VO/lipsync
// attached) are preserved even if the user reduces the count.
// ===========================================================================

function Step2Avatars({
  briefs,
  onSetAvatarCount,
}: {
  briefs: Brief[];
  onSetAvatarCount: (briefId: string, hookId: string, count: number) => void;
}) {
  const allZeroed = briefs.every((b) =>
    b.hooks.every((h) => h.avatars.length === 0),
  );
  return (
    <div className="space-y-5">
      <Intro
        title="Choisis combien d'avatars IA pour chaque hook"
        body="Un avatar = une vidéo lipsync générée par Kling. Tu peux mettre 0 (pas d'avatar IA pour ce hook) jusqu'à 10. Les valeurs sont indépendantes par hook. Tu peux revenir ici à tout moment — les images / voix off déjà rattachées sont préservées si tu réduis."
      />

      {briefs.length === 0 ? (
        <div className="bg-pf-elev border border-pf-border rounded-2xl px-5 py-10 text-center text-pf-muted">
          Aucun brief encore. Reviens à l&apos;étape 1.
        </div>
      ) : (
        <div className="space-y-3">
          {briefs.map((b) => (
            <AvatarBriefCard key={b.id} brief={b} onSetAvatarCount={onSetAvatarCount} />
          ))}
        </div>
      )}

      {allZeroed && briefs.length > 0 && (
        <div className="bg-pf-soft/40 border border-pf-border rounded-xl px-4 py-3 text-sm text-pf-dim">
          Aucun avatar configuré → les étapes Images + Lipsync seront
          automatiquement skippées. Tu peux passer directement à Scripts.
        </div>
      )}
    </div>
  );
}

function AvatarBriefCard({
  brief,
  onSetAvatarCount,
}: {
  brief: Brief;
  onSetAvatarCount: (briefId: string, hookId: string, count: number) => void;
}) {
  const total = brief.hooks.reduce((acc, h) => acc + h.avatars.length, 0);
  const filled = brief.hooks.reduce(
    (acc, h) =>
      acc +
      h.avatars.filter((a) => a.imageUrl || a.voClipUrl || a.lipsyncVideoUrl).length,
    0,
  );
  return (
    <div className="bg-pf-elev border border-pf-border rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-pf-border bg-pf-soft/40 gap-3">
        <div className="min-w-0">
          <div className="text-base font-bold truncate">{brief.adsetName}</div>
          <div className="text-sm text-pf-muted font-mono">
            {brief.hooks.length} hook{brief.hooks.length > 1 ? "s" : ""} ·{" "}
            {total} avatar{total > 1 ? "s" : ""}
            {filled > 0 && (
              <span className="text-pf-ok"> · {filled} avec contenu</span>
            )}
          </div>
        </div>
      </div>
      <div className="divide-y divide-pf-border">
        {brief.hooks.map((h) => {
          const filledHere = h.avatars.filter(
            (a) => a.imageUrl || a.voClipUrl || a.lipsyncVideoUrl,
          ).length;
          const label = h.index === 1 ? "V1" : `Hook ${h.index}`;
          return (
            <div
              key={h.id}
              className="flex items-center justify-between px-5 py-3 gap-4"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <span className="inline-flex items-center justify-center text-sm font-bold font-mono text-pf-text bg-pf-soft border border-pf-border rounded-md px-2.5 py-1 min-w-[56px]">
                  {label}
                </span>
                <div className="min-w-0">
                  <div className="text-sm">
                    {h.avatars.length === 0 ? (
                      <span className="text-pf-muted">Aucun avatar IA</span>
                    ) : (
                      <span className="text-pf-text">
                        {h.avatars.length} avatar
                        {h.avatars.length > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  {filledHere > 0 && (
                    <div className="text-[11px] text-pf-ok">
                      {filledHere} avec contenu rattaché (image / VO / lipsync) —
                      seront préservés
                    </div>
                  )}
                </div>
              </div>
              <AvatarCountPicker
                value={h.avatars.length}
                onChange={(n) => onSetAvatarCount(brief.id, h.id, n)}
                max={MAX_AVATARS_PER_HOOK}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===========================================================================
// Step 3 — Scripts + optional notes + creative ref
// ===========================================================================

function Step3Scripts({
  briefs,
  onUpdateHook,
  onUpdateBrief,
}: {
  briefs: Brief[];
  onUpdateHook: (
    briefId: string,
    hookId: string,
    patch: { hookScript?: string; notes?: string; aiInstructions?: string },
  ) => void;
  onUpdateBrief: (briefId: string, patch: { creativeRef?: string; notes?: string }) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(briefs[0]?.id ?? null);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const b of briefs) {
      for (const h of b.hooks) {
        o[`${b.id}:${h.id}:script`] = h.hookScript;
        o[`${b.id}:${h.id}:notes`] = h.notes ?? "";
        o[`${b.id}:${h.id}:ai`] = h.aiInstructions ?? "";
      }
      o[`${b.id}:ref`] = b.creativeRef ?? "";
    }
    return o;
  });
  const [notesOpen, setNotesOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const b of briefs) {
        for (const h of b.hooks) {
          const k1 = `${b.id}:${h.id}:script`;
          const k2 = `${b.id}:${h.id}:notes`;
          const k4 = `${b.id}:${h.id}:ai`;
          if (next[k1] === undefined) next[k1] = h.hookScript;
          if (next[k2] === undefined) next[k2] = h.notes ?? "";
          if (next[k4] === undefined) next[k4] = h.aiInstructions ?? "";
        }
        const k3 = `${b.id}:ref`;
        if (next[k3] === undefined) next[k3] = b.creativeRef ?? "";
      }
      return next;
    });
  }, [briefs]);

  return (
    <div className="space-y-4">
      <Intro
        title="Saisis les 3 scripts par brief"
        body="V1 = la version originale (script complet). Hook 2 + Hook 3 = juste l'accroche d'ouverture. Tu peux ajouter une note monteur ou une créa de référence (facultatif)."
      />

      {briefs.map((b) => {
        const open = openId === b.id;
        const filled = b.hooks.every((h) => drafts[`${b.id}:${h.id}:script`]?.trim());
        return (
          <div
            key={b.id}
            className={`bg-pf-elev border rounded-2xl overflow-hidden transition-colors ${
              open ? "border-pf-accent" : "border-pf-border"
            }`}
          >
            <button
              type="button"
              onClick={() => setOpenId(open ? null : b.id)}
              className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-pf-soft transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                {open ? (
                  <ChevronDown size={18} className="text-pf-accent shrink-0" />
                ) : (
                  <ChevronRight size={18} className="text-pf-muted shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-base font-bold truncate">{b.adsetName}</div>
                  <div className="text-sm text-pf-muted font-mono">
                    {b.hooks.filter((h) => drafts[`${b.id}:${h.id}:script`]?.trim()).length} / {b.hooks.length} scripts
                  </div>
                </div>
              </div>
              {filled && <BadgeOK label="Complet" />}
            </button>

            {open && (
              <div className="border-t border-pf-border px-5 py-5 space-y-5">
                {b.hooks.map((h) => {
                  const sk = `${b.id}:${h.id}:script`;
                  const nk = `${b.id}:${h.id}:notes`;
                  const ak = `${b.id}:${h.id}:ai`;
                  const nKey = `${b.id}:${h.id}`;
                  const showNotes = notesOpen[nKey] ?? !!drafts[nk]?.trim();
                  // IA directives: always shown when populated (came
                  // from `@` lines in the doc → user already cares),
                  // toggleable when empty. Same UX as notes monteur.
                  const aKey = `${b.id}:${h.id}:ai-open`;
                  const showAi = notesOpen[aKey] ?? !!drafts[ak]?.trim();
                  const label =
                    h.index === 1
                      ? "V1 — Original (script complet)"
                      : `Hook ${h.index} — Variation d'ouverture`;
                  return (
                    <div key={h.id} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-bold uppercase tracking-wider text-pf-muted">
                          {label}
                        </label>
                        <span className="text-xs text-pf-muted font-mono">
                          {(drafts[sk] ?? "").length} chars
                        </span>
                      </div>
                      <textarea
                        value={drafts[sk] ?? ""}
                        onChange={(e) =>
                          setDrafts((d) => ({ ...d, [sk]: e.target.value }))
                        }
                        onBlur={() => onUpdateHook(b.id, h.id, { hookScript: drafts[sk] ?? "" })}
                        placeholder={
                          h.index === 1
                            ? "Écris le script complet (3-30s de VO)…"
                            : "Variation du hook seule (1-3 phrases)."
                        }
                        rows={h.index === 1 ? 6 : 3}
                        className="w-full bg-pf-bg border border-pf-border rounded-xl px-4 py-3 text-base focus:outline-none focus:border-pf-accent leading-relaxed resize-y"
                      />
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setNotesOpen((m) => ({ ...m, [nKey]: !showNotes }))}
                          className="text-xs text-pf-muted hover:text-pf-text inline-flex items-center gap-1"
                        >
                          {showNotes ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          Note monteur {showNotes ? "" : "(optionnelle)"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setNotesOpen((m) => ({ ...m, [aKey]: !showAi }))}
                          className="text-xs text-pf-warn/80 hover:text-pf-warn inline-flex items-center gap-1"
                        >
                          {showAi ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          Instruction IA / workflow {showAi ? "" : "(optionnelle)"}
                        </button>
                      </div>
                      {showNotes && (
                        <textarea
                          value={drafts[nk] ?? ""}
                          onChange={(e) =>
                            setDrafts((d) => ({ ...d, [nk]: e.target.value }))
                          }
                          onBlur={() => onUpdateHook(b.id, h.id, { notes: drafts[nk] ?? "" })}
                          placeholder="Indications de montage spécifiques à ce hook (b-rolls, overlay, rythme…)"
                          rows={2}
                          className="w-full bg-pf-bg border border-pf-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-pf-accent leading-relaxed resize-y italic"
                        />
                      )}
                      {showAi && (
                        <textarea
                          value={drafts[ak] ?? ""}
                          onChange={(e) =>
                            setDrafts((d) => ({ ...d, [ak]: e.target.value }))
                          }
                          onBlur={() =>
                            onUpdateHook(b.id, h.id, { aiInstructions: drafts[ak] ?? "" })
                          }
                          placeholder="Directive pour le SaaS et le monteur (ex: « Le hook ne remplace pas l'original, il vient devant »)"
                          rows={2}
                          className="w-full bg-pf-warn/5 border border-pf-warn/40 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-pf-warn leading-relaxed resize-y"
                        />
                      )}
                    </div>
                  );
                })}

                {/* Per-brief creative ref */}
                <div className="pt-3 border-t border-pf-border space-y-2">
                  <label className="text-sm font-bold uppercase tracking-wider text-pf-muted">
                    Créa de référence (optionnelle)
                  </label>
                  <input
                    type="url"
                    value={drafts[`${b.id}:ref`] ?? ""}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [`${b.id}:ref`]: e.target.value }))
                    }
                    onBlur={() =>
                      onUpdateBrief(b.id, { creativeRef: drafts[`${b.id}:ref`] ?? "" })
                    }
                    placeholder="URL de la créa concurrente à répliquer (Facebook Ads Library, TikTok, etc.)"
                    className="w-full bg-pf-bg border border-pf-border rounded-xl px-4 py-2.5 text-base focus:outline-none focus:border-pf-accent"
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ===========================================================================
// Step 3 — Voice-over — CARD PER BRIEF (V1 / H2 / H3 inside)
// ===========================================================================

function Step4Voiceover({
  briefs,
  voices,
  voiceId,
  onVoiceChange,
  modelId,
  onModelChange,
  voState,
  onRunAll,
  onCancel,
  onRegenerate,
  onCutBlanks,
  pendingCount,
}: {
  briefs: Brief[];
  voices: Voice[];
  voiceId: string;
  onVoiceChange: (id: string) => void;
  modelId: string;
  onModelChange: (id: string) => void;
  voState: Map<string, VoCellState>;
  onRunAll: () => void;
  onCancel: () => void;
  onRegenerate: (briefId: string, hookId: string) => void;
  onCutBlanks: (briefId: string, hookId: string, audioUrl: string) => void;
  pendingCount: number;
}) {
  const totals = useMemo(() => {
    let total = 0,
      done = 0,
      running = 0,
      error = 0;
    for (const b of briefs) {
      for (const h of b.hooks) {
        if (!h.hookScript.trim()) continue;
        total++;
        const s = voState.get(`${b.id}:${h.id}`);
        if (s?.status === "done" || h.cutVoUrl) done++;
        else if (s?.status === "running") running++;
        else if (s?.status === "error") error++;
      }
    }
    return { total, done, running, error };
  }, [briefs, voState]);

  const anyRunning = totals.running > 0;
  const allDone = totals.total > 0 && totals.done === totals.total;

  return (
    <div className="space-y-5">
      <Intro
        title="Génère toutes les voix off"
        body="Une voix par défaut s'applique à tout le batch. Le résultat brut est écrit dans le brief. Pour les hooks qui en ont besoin, clique « ✂ Cut blanks » pour ouvrir le studio et nettoyer les silences."
      />

      {/* Top control bar */}
      <div className="bg-pf-elev border border-pf-border rounded-2xl px-5 py-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2.5 flex-1 min-w-[240px]">
          <Mic size={18} className="text-pf-accent" />
          <select
            value={voiceId}
            onChange={(e) => onVoiceChange(e.target.value)}
            className="flex-1 bg-pf-bg border border-pf-border rounded-lg px-3 py-2.5 text-base focus:outline-none focus:border-pf-accent"
          >
            {voices.length === 0 && <option value="">— Chargement —</option>}
            {voices.map((v) => (
              <option key={v.voiceId} value={v.voiceId}>
                {v.name}
                {v.category ? ` · ${v.category}` : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Model version selector — V2.5 (current) / V3 */}
        <div className="flex items-center gap-1 bg-pf-bg border border-pf-border rounded-lg p-1">
          {VO_MODEL_OPTIONS.map((m) => {
            const active = modelId === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onModelChange(m.id)}
                className={`px-3 py-1.5 rounded-md text-sm font-bold transition-colors ${
                  active
                    ? "bg-pf-accent text-pf-accent-fg"
                    : "text-pf-dim hover:text-pf-text"
                }`}
                title={
                  m.id === "eleven_v3"
                    ? "ElevenLabs V3 (eleven_v3) — voix plus expressive"
                    : "ElevenLabs V2.5 — modèle actuel, stable"
                }
              >
                {m.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 text-sm">
          <Pill label={`${totals.done} / ${totals.total} done`} tone={allDone ? "ok" : "neutral"} />
          {anyRunning && <Pill label={`${totals.running} en cours`} tone="run" />}
          {totals.error > 0 && (
            <Pill label={`${totals.error} erreur${totals.error > 1 ? "s" : ""}`} tone="err" />
          )}
        </div>

        {anyRunning ? (
          <button
            type="button"
            onClick={onCancel}
            className="bg-pf-soft border border-pf-border hover:border-pf-danger text-pf-text hover:text-pf-danger rounded-lg px-4 py-2.5 text-sm font-semibold inline-flex items-center gap-2 transition-colors"
          >
            <Pause size={14} />
            Annuler
          </button>
        ) : (
          <button
            type="button"
            onClick={onRunAll}
            disabled={pendingCount === 0}
            className="bg-pf-accent text-pf-accent-fg font-bold rounded-lg px-5 py-2.5 text-sm inline-flex items-center gap-2 disabled:opacity-40 hover:bg-pf-accent/90 transition-colors"
          >
            <Sparkles size={14} />
            {pendingCount === 0 ? "Tout est généré ✓" : `Générer les ${pendingCount} voix off`}
          </button>
        )}
      </div>

      {/* Brief cards */}
      <div className="space-y-3">
        {briefs.length === 0 && (
          <div className="bg-pf-elev border border-pf-border rounded-2xl px-5 py-10 text-center text-pf-muted">
            Aucun brief avec un script. Reviens à l&apos;étape 2.
          </div>
        )}

        {briefs.map((b) => {
          const hookRows = b.hooks.filter((h) => h.hookScript.trim());
          if (hookRows.length === 0) return null;
          const doneCount = hookRows.filter(
            (h) =>
              h.cutVoUrl || voState.get(`${b.id}:${h.id}`)?.status === "done",
          ).length;
          const allDoneInBrief = doneCount === hookRows.length;
          return (
            <div
              key={b.id}
              className={`bg-pf-elev border rounded-2xl overflow-hidden ${
                allDoneInBrief ? "border-pf-ok/40" : "border-pf-border"
              }`}
            >
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-pf-border bg-pf-soft/40">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-pf-accent/15 border border-pf-accent/30 text-pf-accent flex items-center justify-center shrink-0">
                    <Mic size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-base font-bold truncate">{b.adsetName}</div>
                    <div className="text-sm text-pf-muted font-mono">
                      {doneCount} / {hookRows.length} voix off
                    </div>
                  </div>
                </div>
                {allDoneInBrief && <BadgeOK label="Complet" />}
              </div>

              <div className="divide-y divide-pf-border">
                {hookRows.map((h) => {
                  const key = `${b.id}:${h.id}`;
                  const s = voState.get(key);
                  // Prefer the localStorage URL over the in-memory voState
                  // URL. `hook.cutVoUrl` is the single source of truth
                  // (written by both the batch VO generator AND the
                  // /cut-silence attach flow), so when the user comes
                  // back from cut-silence, the cleaned audio wins —
                  // otherwise the stale voState URL from the original
                  // generation would still be displayed.
                  const url = h.cutVoUrl || s?.url;
                  const status: VoCellStatus = s?.status ?? (url ? "done" : "idle");
                  const hookLabel = h.index === 1 ? "V1" : `Hook ${h.index}`;
                  return (
                    <div key={key} className="grid grid-cols-[80px_1fr] gap-4 px-5 py-4 items-center">
                      <div className="flex items-center gap-2">
                        <span className="text-base font-bold font-mono text-pf-text bg-pf-soft border border-pf-border rounded-md px-2.5 py-1">
                          {hookLabel}
                        </span>
                      </div>
                      <div className="space-y-2 min-w-0">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <StatusBadge status={status} error={s?.error} />
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => onRegenerate(b.id, h.id)}
                              disabled={status === "running"}
                              className="inline-flex items-center gap-1.5 text-sm text-pf-dim hover:text-pf-accent border border-pf-border hover:border-pf-accent rounded-lg px-3 py-1.5 disabled:opacity-40 transition-colors"
                            >
                              {status === "running" ? (
                                <Loader2 size={13} className="animate-spin" />
                              ) : (
                                <RefreshCw size={13} />
                              )}
                              {url ? "Re-gen" : "Gen"}
                            </button>
                            {url && (
                              <button
                                type="button"
                                onClick={() => onCutBlanks(b.id, h.id, url)}
                                className="inline-flex items-center gap-1.5 text-sm font-semibold bg-pf-accent/15 border border-pf-accent/40 text-pf-accent hover:bg-pf-accent/25 rounded-lg px-3 py-1.5 transition-colors"
                                title="Ouvrir Cut Silence avec cet audio préchargé"
                              >
                                <Scissors size={13} />
                                Cut blanks
                              </button>
                            )}
                          </div>
                        </div>
                        {url ? (
                          // eslint-disable-next-line jsx-a11y/media-has-caption
                          <audio key={url} controls src={url} className="w-full h-9" />
                        ) : (
                          <p className="text-sm text-pf-muted line-clamp-2 leading-relaxed">
                            {h.hookScript.slice(0, 120)}
                            {h.hookScript.length > 120 ? "…" : ""}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===========================================================================
// Step 4 — Images (per-brief progress + open in wizard)
// ===========================================================================

type AvatarRowHandlers = {
  onUploadImageToAvatar: (briefId: string, hookId: string, avatarId: string, file: File) => Promise<void>;
  onClearAvatarImage: (briefId: string, hookId: string, avatarId: string) => void;
  onUploadVoToAvatar: (briefId: string, hookId: string, avatarId: string, file: File) => Promise<void>;
  onClearAvatarVo: (briefId: string, hookId: string, avatarId: string) => void;
  onUseHookVoForOneAvatar: (briefId: string, hookId: string, avatarId: string) => void;
};

function Step5Images({
  briefs,
  onOpenBrief,
  onUseHookVoForAvatars,
  ...handlers
}: {
  briefs: Brief[];
  onOpenBrief: (id: string) => void;
  onUseHookVoForAvatars: (briefId: string) => void;
} & AvatarRowHandlers) {
  const withAvatars = briefs.filter((b) =>
    b.hooks.some((h) => h.avatars.length > 0),
  );

  if (withAvatars.length === 0) {
    return (
      <div className="bg-pf-elev border border-pf-border rounded-2xl p-10 text-center">
        <Sparkles size={32} className="mx-auto text-pf-accent mb-4" />
        <h3 className="text-lg font-bold mb-2">Aucun brief avec avatar IA</h3>
        <p className="text-sm text-pf-dim max-w-md mx-auto">
          Tu as choisi 0 avatar pour tous les briefs (étape 2). On passe
          directement au sync.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Intro
        title="Assigne une image à chaque avatar"
        body="Liste tous les hooks de chaque brief avec leurs avatars. Pour chaque avatar : upload une image depuis ton PC, ou clique « Générer » pour ouvrir le studio. Tu peux revenir à tout moment — les images déjà rattachées restent affichées et préservées."
      />

      <div className="flex flex-wrap items-center gap-2">
        <UploadAndAttachButton
          label="Uploader (avec choix du slot)"
          className="inline-flex items-center gap-2 bg-pf-soft border border-pf-border hover:border-pf-accent rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-40"
        />
        <Link
          href="/prompts"
          target="_blank"
          className="inline-flex items-center gap-2 bg-pf-soft border border-pf-border hover:border-pf-accent rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors"
        >
          <ImageIcon size={15} />
          Générer des images (Prompts)
          <ExternalLink size={12} className="text-pf-muted" />
        </Link>
        <Link
          href="/voiceover"
          target="_blank"
          className="inline-flex items-center gap-2 bg-pf-soft border border-pf-border hover:border-pf-accent rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors"
        >
          <Mic size={15} />
          Générer des voix off (Voiceover)
          <ExternalLink size={12} className="text-pf-muted" />
        </Link>
      </div>

      <div className="space-y-4">
        {withAvatars.map((b) => (
          <BriefImageList
            key={b.id}
            brief={b}
            onOpenBrief={onOpenBrief}
            onUseHookVoForAvatars={onUseHookVoForAvatars}
            {...handlers}
          />
        ))}
      </div>
    </div>
  );
}

// One brief = one expandable list of hooks → avatars. Header shows the
// brief name + per-asset progress; body lists every (hook, avatar) row
// with inline Upload + Generate + (when filled) Clear actions, on TWO
// sub-rows: one for the avatar's image, one for its voice clip.
function BriefImageList({
  brief,
  onOpenBrief,
  onUseHookVoForAvatars,
  ...handlers
}: {
  brief: Brief;
  onOpenBrief: (id: string) => void;
  onUseHookVoForAvatars: (briefId: string) => void;
} & AvatarRowHandlers) {
  const totalSlots = brief.hooks.reduce((acc, h) => acc + h.avatars.length, 0);
  const imagesAssigned = brief.hooks.reduce(
    (acc, h) => acc + h.avatars.filter((a) => a.imageUrl).length,
    0,
  );
  const voAssigned = brief.hooks.reduce(
    (acc, h) => acc + h.avatars.filter((a) => a.voClipUrl).length,
    0,
  );
  const pct = totalSlots === 0 ? 0 : Math.round((imagesAssigned / totalSlots) * 100);
  const allReady =
    totalSlots > 0 && imagesAssigned === totalSlots && voAssigned === totalSlots;
  const canCloneHookVo = brief.hooks.some(
    (h) => h.cutVoUrl && h.avatars.some((a) => !a.voClipUrl),
  );

  // Only render hooks that have at least one avatar — empty hooks are
  // a no-op here (their slot count is 0, so nothing to assign).
  const hooksWithAvatars = brief.hooks.filter((h) => h.avatars.length > 0);

  return (
    <div
      className={`bg-pf-elev border rounded-2xl overflow-hidden ${
        allReady ? "border-pf-ok/40" : "border-pf-border"
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-pf-border bg-pf-soft/40">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-pf-accent/15 border border-pf-accent/30 text-pf-accent flex items-center justify-center shrink-0">
            <Users size={16} />
          </div>
          <div className="min-w-0">
            <div className="text-base font-bold truncate">{brief.adsetName}</div>
            <div className="text-sm text-pf-muted font-mono mt-0.5">
              {totalSlots} avatar{totalSlots > 1 ? "s" : ""} ·{" "}
              <span className={imagesAssigned === totalSlots ? "text-pf-ok" : ""}>
                {imagesAssigned}/{totalSlots} images
              </span>
              {" · "}
              <span className={voAssigned === totalSlots ? "text-pf-ok" : ""}>
                {voAssigned}/{totalSlots} VO
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canCloneHookVo && (
            <button
              type="button"
              onClick={() => onUseHookVoForAvatars(brief.id)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-pf-dim hover:text-pf-text border border-pf-border hover:border-pf-accent rounded-md px-2.5 py-1.5 transition-colors"
              title="Copie la voix off de chaque hook sur tous ses avatars (sans toucher aux clips déjà rattachés)."
            >
              <Mic size={12} />
              VO du hook
            </button>
          )}
          <button
            type="button"
            onClick={() => onOpenBrief(brief.id)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-pf-dim hover:text-pf-text border border-pf-border hover:border-pf-accent rounded-md px-2.5 py-1.5 transition-colors"
            title="Ouvrir le wizard détaillé du brief"
          >
            Wizard
            <ArrowRight size={11} />
          </button>
          {allReady ? <BadgeOK label="Complet" /> : <Pill label={`${pct}%`} tone="neutral" />}
        </div>
      </div>

      {/* Hooks list — each hook is a group with its avatars as sub-rows */}
      <div className="divide-y divide-pf-border">
        {hooksWithAvatars.map((h) => (
          <HookAvatarGroup
            key={h.id}
            briefId={brief.id}
            hook={h}
            {...handlers}
          />
        ))}
      </div>
    </div>
  );
}

function HookAvatarGroup({
  briefId,
  hook,
  ...handlers
}: {
  briefId: string;
  hook: HookBrief;
} & AvatarRowHandlers) {
  const label = hook.index === 1 ? "V1 — Original" : `Hook ${hook.index}`;
  const imagesFilled = hook.avatars.filter((a) => a.imageUrl).length;
  const voFilled = hook.avatars.filter((a) => a.voClipUrl).length;
  return (
    <div>
      {/* Hook sub-header */}
      <div className="flex items-center gap-3 px-5 py-2.5 bg-pf-bg/40 border-b border-pf-border/60">
        <span className="inline-flex items-center justify-center text-xs font-bold font-mono text-pf-text bg-pf-soft border border-pf-border rounded-md px-2 py-0.5 min-w-[48px]">
          {hook.index === 1 ? "V1" : `H${hook.index}`}
        </span>
        <div className="text-sm font-semibold text-pf-text">{label}</div>
        <span className="text-xs text-pf-muted font-mono ml-auto">
          {imagesFilled}/{hook.avatars.length} img · {voFilled}/{hook.avatars.length} VO
        </span>
      </div>
      {/* Avatar rows */}
      <div className="divide-y divide-pf-border/40">
        {hook.avatars.map((av, idx) => (
          <AvatarSlotRow
            key={av.id}
            briefId={briefId}
            hookId={hook.id}
            hookHasVo={!!hook.cutVoUrl}
            avatar={av}
            avatarIdx={idx}
            {...handlers}
          />
        ))}
      </div>
    </div>
  );
}

function AvatarSlotRow({
  briefId,
  hookId,
  hookHasVo,
  avatar,
  avatarIdx,
  onUploadImageToAvatar,
  onClearAvatarImage,
  onUploadVoToAvatar,
  onClearAvatarVo,
  onUseHookVoForOneAvatar,
}: {
  briefId: string;
  hookId: string;
  hookHasVo: boolean;
  avatar: AvatarSlot;
  avatarIdx: number;
} & AvatarRowHandlers) {
  const hasImage = !!avatar.imageUrl;
  const hasVo = !!avatar.voClipUrl;

  return (
    <div className="px-5 py-3 space-y-2.5">
      {/* Header row — thumbnail + label + global status */}
      <div className="flex items-center gap-3">
        <div className="w-14 h-14 rounded-lg border border-pf-border bg-pf-bg shrink-0 flex items-center justify-center overflow-hidden">
          {hasImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatar.imageUrl!}
              alt={avatar.label}
              className="w-full h-full object-cover"
            />
          ) : (
            <ImageIcon size={20} className="text-pf-muted" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-pf-text truncate">
            Avatar {avatarIdx + 1}
            {avatar.label && avatar.label !== `Avatar IA ${avatarIdx + 1}` && (
              <span className="text-pf-muted ml-1.5 font-normal">— {avatar.label}</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[11px] font-mono">
            <span className={hasImage ? "text-pf-ok" : "text-pf-muted"}>
              {hasImage ? "✓ Image" : "— Image"}
            </span>
            <span className={hasVo ? "text-pf-ok" : "text-pf-muted"}>
              {hasVo ? "✓ VO" : "— VO"}
            </span>
          </div>
        </div>
      </div>

      {/* Image actions row */}
      <SlotActionRow
        label="Image"
        accept="image/png,image/jpeg,image/webp"
        currentUrl={avatar.imageUrl}
        isAudio={false}
        generateHref="/"
        generateTitle="Ouvrir le studio image. Génère, puis utilise « 📎 Rattacher au brief » pour l'attacher ici."
        onUpload={async (file) => onUploadImageToAvatar(briefId, hookId, avatar.id, file)}
        onClear={() => onClearAvatarImage(briefId, hookId, avatar.id)}
      />

      {/* VO actions row */}
      <SlotActionRow
        label="Voix off"
        accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/aac,audio/mp4,audio/ogg,audio/webm"
        currentUrl={avatar.voClipUrl}
        isAudio={true}
        generateHref="/voiceover"
        generateTitle="Ouvrir le studio voix off. Génère, puis utilise « 📎 Rattacher au brief » pour l'attacher ici."
        onUpload={async (file) => onUploadVoToAvatar(briefId, hookId, avatar.id, file)}
        onClear={() => onClearAvatarVo(briefId, hookId, avatar.id)}
        leftAction={
          hookHasVo ? (
            <button
              type="button"
              onClick={() => onUseHookVoForOneAvatar(briefId, hookId, avatar.id)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold bg-pf-soft border border-pf-border hover:border-pf-accent text-pf-text rounded-md px-2.5 py-1.5 transition-colors"
              title={
                hasVo
                  ? "Remplacer la VO actuelle par celle du hook"
                  : "Copier la voix off du hook (cutVoUrl) dans ce slot"
              }
            >
              <Mic size={12} />
              VO du hook
            </button>
          ) : null
        }
      />
    </div>
  );
}

// One uniform action row used for both image and VO. Handles the file
// input + Upload/Remplacer label + Générer link + optional Vider button
// + an optional extra leftAction slot (used by VO for "VO du hook").
function SlotActionRow({
  label,
  accept,
  currentUrl,
  isAudio,
  generateHref,
  generateTitle,
  leftAction,
  onUpload,
  onClear,
}: {
  label: string;
  accept: string;
  currentUrl: string | undefined;
  isAudio: boolean;
  generateHref: string;
  generateTitle: string;
  leftAction?: React.ReactNode;
  onUpload: (file: File) => Promise<void>;
  onClear: () => void;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePick = useCallback(
    async (file: File) => {
      setUploading(true);
      setError(null);
      try {
        await onUpload(file);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
      }
    },
    [onUpload],
  );

  const filled = !!currentUrl;

  return (
    <div className="flex items-center gap-2 pl-[68px]">
      <span className="text-[11px] font-mono uppercase tracking-wider text-pf-muted shrink-0 min-w-[56px]">
        {label}
      </span>
      {isAudio && filled && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio src={currentUrl} controls className="h-6 max-w-[180px] shrink-0" />
      )}
      <div className="flex items-center gap-1.5 ml-auto shrink-0">
        {leftAction}
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-1.5 text-xs font-semibold bg-pf-accent/15 border border-pf-accent/40 text-pf-accent hover:bg-pf-accent/25 rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-40"
          title={filled ? `Remplacer ${label.toLowerCase()}` : `Uploader ${label.toLowerCase()} depuis ton PC`}
        >
          {uploading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Upload size={12} />
          )}
          {filled ? "Remplacer" : "Upload"}
        </button>
        <Link
          href={generateHref}
          target="_blank"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-pf-dim hover:text-pf-text border border-pf-border hover:border-pf-accent rounded-md px-2.5 py-1.5 transition-colors"
          title={generateTitle}
        >
          <Sparkles size={12} />
          Générer
        </Link>
        {filled && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center justify-center w-8 h-8 text-pf-muted hover:text-pf-danger border border-pf-border hover:border-pf-danger rounded-md transition-colors"
            title={`Vider ce slot ${label.toLowerCase()}`}
          >
            <X size={13} />
          </button>
        )}
        {error && <span className="text-[11px] text-pf-danger ml-1 max-w-[160px] truncate">{error}</span>}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void handlePick(f);
        }}
      />
    </div>
  );
}

function ChecklineRow({ label, done, total }: { label: string; done: number; total: number }) {
  const ok = done === total && total > 0;
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-pf-dim">{label}</span>
      <span className={`font-mono ${ok ? "text-pf-ok" : "text-pf-muted"}`}>
        {done} / {total}
        {ok && " ✓"}
      </span>
    </div>
  );
}

// ===========================================================================
// Step 5 — Lipsync (batch with Kling polling)
// ===========================================================================

function Step6Lipsync({
  briefs,
  lipsyncState,
  onRunAll,
  onCancel,
  onTriggerOne,
  onResetOne,
  pendingCount,
  anyRunning,
  onOpenBrief,
}: {
  briefs: Brief[];
  lipsyncState: Map<string, LsCellState>;
  onRunAll: () => void;
  onCancel: () => void;
  onTriggerOne: (briefId: string, hookId: string, avatarId: string) => Promise<void>;
  onResetOne: (briefId: string, hookId: string, avatarId: string) => void;
  pendingCount: number;
  anyRunning: boolean;
  onOpenBrief: (id: string) => void;
}) {
  const withAvatars = briefs.filter(briefHasAvatars);

  const totals = useMemo(() => {
    let total = 0,
      done = 0,
      running = 0,
      error = 0,
      notReady = 0;
    for (const b of withAvatars) {
      for (const h of b.hooks) {
        for (const av of h.avatars) {
          total++;
          if (av.lipsyncStatus === "done" && av.lipsyncVideoUrl) {
            done++;
            continue;
          }
          if (!av.imageUrl || !av.voClipUrl) {
            notReady++;
            continue;
          }
          const s = lipsyncState.get(`${b.id}:${h.id}:${av.id}`);
          if (s?.status === "running") running++;
          else if (s?.status === "error") error++;
        }
      }
    }
    return { total, done, running, error, notReady };
  }, [withAvatars, lipsyncState]);

  if (withAvatars.length === 0) {
    return (
      <div className="bg-pf-elev border border-pf-border rounded-2xl p-10 text-center">
        <Video size={32} className="mx-auto text-pf-accent mb-4" />
        <h3 className="text-lg font-bold mb-2">Pas de lipsync à générer</h3>
        <p className="text-sm text-pf-dim max-w-md mx-auto">
          Aucun brief n&apos;a d&apos;avatar IA dans ce batch.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Intro
        title="Vérifie chaque paire (image + VO), puis génère les lipsyncs"
        body="Chaque avatar affiche sa miniature d'image et son player audio pour que tu vérifies que ça matche avant de générer. Click « Générer » sur la row pour lancer ce lipsync seul, ou « Lancer la file (séquentiel) » en haut pour les enchaîner UN PAR UN. Chaque vidéo s'attribue automatiquement au bon brief."
      />

      <div className="bg-pf-elev border border-pf-border rounded-2xl px-5 py-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 flex-1 flex-wrap">
          <Pill label={`${totals.done} / ${totals.total} done`} tone={totals.done === totals.total ? "ok" : "neutral"} />
          {totals.running > 0 && <Pill label={`${totals.running} en cours`} tone="run" />}
          {totals.error > 0 && <Pill label={`${totals.error} erreurs`} tone="err" />}
          {totals.notReady > 0 && <Pill label={`${totals.notReady} pas prêt(s)`} tone="muted" />}
        </div>
        {anyRunning ? (
          <button
            type="button"
            onClick={onCancel}
            className="bg-pf-soft border border-pf-border hover:border-pf-danger text-pf-text hover:text-pf-danger rounded-lg px-4 py-2.5 text-sm font-semibold inline-flex items-center gap-2 transition-colors"
          >
            <Pause size={14} />
            Stop file
          </button>
        ) : (
          <button
            type="button"
            onClick={onRunAll}
            disabled={pendingCount === 0}
            className="bg-pf-accent text-pf-accent-fg font-bold rounded-lg px-5 py-2.5 text-sm inline-flex items-center gap-2 disabled:opacity-40 hover:bg-pf-accent/90 transition-colors"
            title="Lance les lipsyncs un par un (séquentiel). Tu vois chacun se finir avant que le suivant ne démarre."
          >
            <Sparkles size={14} />
            {pendingCount === 0
              ? totals.notReady > 0
                ? "Avatars incomplets — assigne images + voix"
                : "Tout est généré ✓"
              : `Lancer la file (${pendingCount} séquentiel)`}
          </button>
        )}
      </div>

      <div className="space-y-4">
        {withAvatars.map((b) => (
          <BriefLipsyncList
            key={b.id}
            brief={b}
            lipsyncState={lipsyncState}
            onTriggerOne={onTriggerOne}
            onResetOne={onResetOne}
            onOpenBrief={onOpenBrief}
          />
        ))}
      </div>
    </div>
  );
}

// Same shape as BriefImageList (Step 5): brief header + per-hook groups
// + per-avatar rows. But each row shows the IMAGE + VO inputs so the
// user can verify the pair, plus a "Générer ce lipsync" button.
function BriefLipsyncList({
  brief,
  lipsyncState,
  onTriggerOne,
  onResetOne,
  onOpenBrief,
}: {
  brief: Brief;
  lipsyncState: Map<string, LsCellState>;
  onTriggerOne: (briefId: string, hookId: string, avatarId: string) => Promise<void>;
  onResetOne: (briefId: string, hookId: string, avatarId: string) => void;
  onOpenBrief: (id: string) => void;
}) {
  const slots = brief.hooks.flatMap((h) => h.avatars);
  const briefDone =
    slots.length > 0 &&
    slots.every((a) => a.lipsyncStatus === "done" && a.lipsyncVideoUrl);
  const doneCount = slots.filter(
    (a) => a.lipsyncStatus === "done" && a.lipsyncVideoUrl,
  ).length;
  const hooksWithAvatars = brief.hooks.filter((h) => h.avatars.length > 0);

  return (
    <div
      className={`bg-pf-elev border rounded-2xl overflow-hidden ${
        briefDone ? "border-pf-ok/40" : "border-pf-border"
      }`}
    >
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-pf-border bg-pf-soft/40">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-pf-accent/15 border border-pf-accent/30 text-pf-accent flex items-center justify-center shrink-0">
            <Video size={16} />
          </div>
          <div className="min-w-0">
            <div className="text-base font-bold truncate">{brief.adsetName}</div>
            <div className="text-sm text-pf-muted font-mono mt-0.5">
              {doneCount}/{slots.length} lipsyncs
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onOpenBrief(brief.id)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-pf-dim hover:text-pf-text border border-pf-border hover:border-pf-accent rounded-md px-2.5 py-1.5 transition-colors"
            title="Ouvrir le wizard détaillé du brief"
          >
            Wizard
            <ArrowRight size={11} />
          </button>
          {briefDone && <BadgeOK label="OK" />}
        </div>
      </div>

      <div className="divide-y divide-pf-border">
        {hooksWithAvatars.map((h) => (
          <HookLipsyncGroup
            key={h.id}
            briefId={brief.id}
            hook={h}
            lipsyncState={lipsyncState}
            onTriggerOne={onTriggerOne}
            onResetOne={onResetOne}
          />
        ))}
      </div>
    </div>
  );
}

function HookLipsyncGroup({
  briefId,
  hook,
  lipsyncState,
  onTriggerOne,
  onResetOne,
}: {
  briefId: string;
  hook: HookBrief;
  lipsyncState: Map<string, LsCellState>;
  onTriggerOne: (briefId: string, hookId: string, avatarId: string) => Promise<void>;
  onResetOne: (briefId: string, hookId: string, avatarId: string) => void;
}) {
  const label = hook.index === 1 ? "V1 — Original" : `Hook ${hook.index}`;
  const doneHere = hook.avatars.filter(
    (a) => a.lipsyncStatus === "done" && a.lipsyncVideoUrl,
  ).length;
  return (
    <div>
      <div className="flex items-center gap-3 px-5 py-2.5 bg-pf-bg/40 border-b border-pf-border/60">
        <span className="inline-flex items-center justify-center text-xs font-bold font-mono text-pf-text bg-pf-soft border border-pf-border rounded-md px-2 py-0.5 min-w-[48px]">
          {hook.index === 1 ? "V1" : `H${hook.index}`}
        </span>
        <div className="text-sm font-semibold text-pf-text">{label}</div>
        <span className="text-xs text-pf-muted font-mono ml-auto">
          {doneHere}/{hook.avatars.length} lipsyncs
        </span>
      </div>
      <div className="divide-y divide-pf-border/40">
        {hook.avatars.map((av, idx) => (
          <LipsyncSlotRow
            key={av.id}
            briefId={briefId}
            hookId={hook.id}
            avatar={av}
            avatarIdx={idx}
            state={lipsyncState.get(`${briefId}:${hook.id}:${av.id}`)}
            onTriggerOne={onTriggerOne}
            onResetOne={onResetOne}
          />
        ))}
      </div>
    </div>
  );
}

function LipsyncSlotRow({
  briefId,
  hookId,
  avatar,
  avatarIdx,
  state,
  onTriggerOne,
  onResetOne,
}: {
  briefId: string;
  hookId: string;
  avatar: AvatarSlot;
  avatarIdx: number;
  state: LsCellState | undefined;
  onTriggerOne: (briefId: string, hookId: string, avatarId: string) => Promise<void>;
  onResetOne: (briefId: string, hookId: string, avatarId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const hasImage = !!avatar.imageUrl;
  const hasVo = !!avatar.voClipUrl;
  const ready = hasImage && hasVo;
  const done = avatar.lipsyncStatus === "done" && !!avatar.lipsyncVideoUrl;
  const url = avatar.lipsyncVideoUrl || state?.url;
  const status: LsCellStatus = done
    ? "done"
    : state?.status ?? "idle";

  const handleGenerate = useCallback(async () => {
    if (!ready || done || status === "running") return;
    setBusy(true);
    try {
      await onTriggerOne(briefId, hookId, avatar.id);
    } finally {
      setBusy(false);
    }
  }, [briefId, hookId, avatar.id, onTriggerOne, ready, done, status]);

  return (
    <div className="px-5 py-3 flex items-center gap-3 flex-wrap md:flex-nowrap">
      {/* Thumbnail */}
      <div className="w-16 h-16 rounded-lg border border-pf-border bg-pf-bg shrink-0 flex items-center justify-center overflow-hidden">
        {hasImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatar.imageUrl!}
            alt={avatar.label}
            className="w-full h-full object-cover"
          />
        ) : (
          <ImageIcon size={20} className="text-pf-muted" />
        )}
      </div>

      {/* Label + audio + status */}
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="text-sm font-semibold text-pf-text truncate">
          Avatar {avatarIdx + 1}
          {avatar.label && avatar.label !== `Avatar IA ${avatarIdx + 1}` && (
            <span className="text-pf-muted ml-1.5 font-normal">— {avatar.label}</span>
          )}
        </div>
        {hasVo ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <audio src={avatar.voClipUrl} controls className="h-7 max-w-full" />
        ) : (
          <div className="text-[11px] text-pf-muted">
            Pas de voix off rattachée — retourne à l&apos;étape 5
          </div>
        )}
      </div>

      {/* Status + actions */}
      <div className="flex items-center gap-2 shrink-0">
        <LipsyncStatusBadge status={status} ready={ready} hasImage={hasImage} hasVo={hasVo} error={state?.error} />
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-pf-accent hover:underline border border-pf-border hover:border-pf-accent rounded-md px-2.5 py-1.5"
            title="Ouvrir la vidéo lipsync générée"
          >
            <ExternalLink size={11} />
            Voir vidéo
          </a>
        )}
        {/* Escape hatch when a row is stuck in "running" — typically
            because the page was reloaded and the in-memory poller died
            without a recoverable batchId. Clears the cell state so the
            user can re-trigger from scratch. */}
        {status === "running" && !done && (
          <button
            type="button"
            onClick={() => onResetOne(briefId, hookId, avatar.id)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-pf-muted hover:text-pf-danger border border-pf-border hover:border-pf-danger rounded-md px-2.5 py-1.5 transition-colors"
            title="Débloquer cette row (si elle reste « En cours » sans rien faire)"
          >
            Réinitialiser
          </button>
        )}
        <button
          type="button"
          onClick={handleGenerate}
          disabled={!ready || done || status === "running" || busy}
          className={`inline-flex items-center gap-1.5 text-xs font-semibold rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            done
              ? "bg-pf-soft border border-pf-border text-pf-muted"
              : "bg-pf-accent text-pf-accent-fg hover:bg-pf-accent/90 border border-pf-accent"
          }`}
          title={
            !ready
              ? "Il manque l'image ou la VO — retourne à l'étape 5"
              : done
                ? "Déjà généré — utilise « Voir vidéo »"
                : status === "running"
                  ? "En cours — attends la fin ou clique Réinitialiser"
                  : "Lancer Kling pour ce lipsync"
          }
        >
          {status === "running" || busy ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Sparkles size={11} />
          )}
          {done ? "Done" : status === "running" ? "En cours…" : "Générer"}
        </button>
      </div>
    </div>
  );
}

function LipsyncStatusBadge({
  status,
  ready,
  hasImage,
  hasVo,
  error,
}: {
  status: LsCellStatus;
  ready: boolean;
  hasImage: boolean;
  hasVo: boolean;
  error?: string;
}) {
  if (!ready) {
    const missing: string[] = [];
    if (!hasImage) missing.push("image");
    if (!hasVo) missing.push("VO");
    return (
      <Pill label={`${missing.join(" + ")} manquant${missing.length > 1 ? "s" : ""}`} tone="muted" />
    );
  }
  if (status === "done") {
    return (
      <span className="inline-flex items-center gap-1 text-pf-ok text-xs font-semibold">
        <Check size={12} className="pf-success-pop" />
        Done
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 text-pf-warn text-xs font-semibold">
        <span className="w-1.5 h-1.5 rounded-full bg-pf-warn pf-pulse-dot" />
        En cours
      </span>
    );
  }
  if (status === "error") {
    // Show the actual error message inline (truncated) instead of
    // hiding it in a tooltip — the user can't debug "Erreur" alone.
    // Full message stays available on hover via `title`.
    const short = error ? error.replace(/\s+/g, " ").trim().slice(0, 90) : "";
    return (
      <span
        className="inline-flex items-center gap-1.5 text-pf-danger text-xs font-semibold max-w-[280px]"
        title={error || "Erreur Kling"}
      >
        <span>Erreur</span>
        {short && (
          <span className="text-pf-muted font-normal truncate">— {short}</span>
        )}
      </span>
    );
  }
  return <span className="text-pf-muted text-xs">Prêt</span>;
}

// ===========================================================================
// Step 6 — Sync (was 5)
// ===========================================================================

function Step7Sync({
  briefs,
  syncState,
  onSyncAll,
  onSyncOne,
  voState,
  lipsyncState,
}: {
  briefs: Brief[];
  syncState: Map<string, SyncCellState>;
  onSyncAll: () => void;
  onSyncOne: (b: Brief) => void;
  voState: Map<string, VoCellState>;
  lipsyncState: Map<string, LsCellState>;
}) {
  const totals = useMemo(() => {
    let done = 0,
      running = 0,
      error = 0;
    for (const b of briefs) {
      const s = syncState.get(b.id);
      if (s?.status === "done") done++;
      else if (s?.status === "running") running++;
      else if (s?.status === "error") error++;
    }
    return { done, running, error, total: briefs.length };
  }, [briefs, syncState]);

  return (
    <div className="space-y-5">
      <Intro
        title="Pousse tout vers Notion + Drive"
        body="Chaque brief crée 3 pages Notion (1 par hook). Les voix off et avatars sont uploadés vers Drive selon l'arborescence. Le lien Notion s'affiche dès qu'un brief est sync."
      />

      <div className="bg-pf-elev border border-pf-border rounded-2xl px-5 py-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 flex-1 flex-wrap">
          <Pill
            label={`${totals.done} / ${totals.total} sync`}
            tone={totals.done === totals.total ? "ok" : "neutral"}
          />
          {totals.running > 0 && <Pill label={`${totals.running} en cours`} tone="run" />}
          {totals.error > 0 && (
            <Pill label={`${totals.error} erreur${totals.error > 1 ? "s" : ""}`} tone="err" />
          )}
        </div>
        <button
          type="button"
          onClick={onSyncAll}
          disabled={totals.running > 0}
          className="bg-pf-accent text-pf-accent-fg font-bold rounded-lg px-5 py-2.5 text-sm inline-flex items-center gap-2 disabled:opacity-40 hover:bg-pf-accent/90 transition-colors"
        >
          <Sparkles size={14} />
          Push tout vers Notion
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {briefs.map((b) => {
          const s = syncState.get(b.id);
          const status = s?.status ?? "idle";
          const filledHooks = b.hooks.filter((h) => h.hookScript.trim()).length;
          const filledVo = b.hooks.filter(
            (h) =>
              h.cutVoUrl || voState.get(`${b.id}:${h.id}`)?.status === "done",
          ).length;
          const totalLs = b.hooks.reduce((acc, h) => acc + h.avatars.length, 0);
          const doneLs = b.hooks.reduce(
            (acc, h) =>
              acc +
              h.avatars.filter(
                (a) =>
                  (a.lipsyncStatus === "done" && a.lipsyncVideoUrl) ||
                  lipsyncState.get(`${b.id}:${h.id}:${a.id}`)?.status === "done",
              ).length,
            0,
          );
          const borderClass =
            status === "done"
              ? "border-pf-ok/50"
              : status === "error"
                ? "border-pf-danger/50"
                : "border-pf-border";
          return (
            <div key={b.id} className={`bg-pf-elev border rounded-2xl p-5 ${borderClass}`}>
              <div className="flex items-start justify-between mb-3 gap-3">
                <div className="min-w-0">
                  <div className="text-base font-bold truncate">{b.adsetName}</div>
                  <div className="text-sm text-pf-muted font-mono mt-0.5">
                    {b.hooks.length} hook{b.hooks.length > 1 ? "s" : ""}
                    {totalLs > 0 ? ` · ${totalLs} avatar${totalLs > 1 ? "s" : ""}` : ""}
                  </div>
                </div>
                <div className="shrink-0">
                  <SyncStatusBadge status={status} error={s?.error} />
                </div>
              </div>

              <div className="space-y-2 my-4">
                <ChecklineRow label="Scripts" done={filledHooks} total={b.hooks.length} />
                <ChecklineRow label="Voix off" done={filledVo} total={b.hooks.length} />
                {totalLs > 0 && (
                  <ChecklineRow label="Lipsyncs" done={doneLs} total={totalLs} />
                )}
              </div>

              {s?.url && (
                <Link
                  href={s.url}
                  target="_blank"
                  className="inline-flex items-center gap-1.5 text-sm text-pf-accent hover:underline mb-3"
                >
                  Voir la page Notion <ExternalLink size={12} />
                </Link>
              )}

              {s?.error && (
                <div className="text-sm text-pf-danger bg-pf-danger/10 border border-pf-danger/30 rounded-lg px-3 py-2 mb-3 leading-relaxed">
                  {s.error}
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onSyncOne(b)}
                  disabled={status === "running"}
                  className="flex-1 text-sm bg-pf-soft border border-pf-border hover:border-pf-accent rounded-lg py-2 disabled:opacity-40 transition-colors inline-flex items-center justify-center gap-2 font-semibold"
                >
                  {status === "running" ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <RefreshCw size={13} />
                  )}
                  {status === "done" ? "Re-sync" : "Sync"}
                </button>
                <Link
                  href={`/briefs/${b.id}`}
                  className="text-sm text-pf-dim hover:text-pf-text border border-pf-border hover:border-pf-accent rounded-lg px-3 py-2 transition-colors font-medium"
                  title="Ouvrir le wizard détaillé"
                >
                  Edit
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===========================================================================
// Shared bits
// ===========================================================================

function Intro({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-pf-soft/40 border border-pf-border rounded-2xl px-5 py-4">
      <div className="text-lg font-bold mb-1">{title}</div>
      <p className="text-sm text-pf-dim leading-relaxed">{body}</p>
    </div>
  );
}

function Pill({
  label,
  tone,
}: {
  label: string;
  tone: "ok" | "run" | "err" | "neutral" | "muted";
}) {
  const c =
    tone === "ok"
      ? "bg-pf-ok/15 text-pf-ok border-pf-ok/40"
      : tone === "run"
        ? "bg-pf-warn/15 text-pf-warn border-pf-warn/40"
        : tone === "err"
          ? "bg-pf-danger/15 text-pf-danger border-pf-danger/40"
          : tone === "muted"
            ? "bg-pf-soft text-pf-muted border-pf-border"
            : "bg-pf-soft text-pf-dim border-pf-border";
  return (
    <span
      className={`inline-flex items-center text-sm font-mono rounded-lg px-2.5 py-1 border ${c}`}
    >
      {label}
    </span>
  );
}

function BadgeOK({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider bg-pf-ok/15 text-pf-ok border border-pf-ok/40 rounded-lg px-2.5 py-1 shrink-0">
      <Check size={14} />
      {label}
    </span>
  );
}

function StatusBadge({ status, error }: { status: VoCellStatus; error?: string }) {
  if (status === "done") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-pf-ok">
        <Check size={15} className="pf-success-pop" />
        Voix off prête
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-2 text-sm font-semibold text-pf-warn">
        <span className="w-2 h-2 rounded-full bg-pf-warn pf-pulse-dot inline-block" />
        En génération…
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-pf-danger" title={error}>
        <X size={14} />
        Erreur
      </span>
    );
  }
  return <span className="text-sm text-pf-muted">En attente</span>;
}

function SyncStatusBadge({ status, error }: { status: SyncCellState["status"]; error?: string }) {
  if (status === "done") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider bg-pf-ok/15 text-pf-ok border border-pf-ok/40 rounded-lg px-2.5 py-1">
        <Check size={14} className="pf-success-pop" />
        Sync
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-2 text-sm font-semibold text-pf-warn bg-pf-warn/15 border border-pf-warn/40 rounded-lg px-2.5 py-1">
        <Loader2 size={13} className="animate-spin" />
        Sync…
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-pf-danger bg-pf-danger/15 border border-pf-danger/40 rounded-lg px-2.5 py-1" title={error}>
        <X size={13} />
        Erreur
      </span>
    );
  }
  return (
    <span className="inline-flex items-center text-sm text-pf-muted bg-pf-soft border border-pf-border rounded-lg px-2.5 py-1">
      Idle
    </span>
  );
}

// ===========================================================================
// Utilities
// ===========================================================================

function makeRow(): DraftRow {
  return {
    rowId: Math.random().toString(36).slice(2, 10),
    briefName: "",
    creativeName: "",
    avatarCount: 0,
  };
}

// True iff this brief has at least one avatar slot somewhere — used to
// gate the Images + Lipsync steps. brief.avatarCount alone is unreliable
// since per-hook counts may differ (e.g. V1=2, H2=1, H3=0 → avatarCount
// is the max=2 but a brief with all zeroes would also have that as 0).
function briefHasAvatars(b: Brief): boolean {
  return b.hooks.some((h) => h.avatars.length > 0);
}

function composeAdsetName(briefName: string, creativeName: string): string {
  const a = briefName.trim();
  const b = creativeName.trim();
  if (a && b) return `${a} — ${b}`;
  return a || b || "Brief sans titre";
}

// Inverse of composeAdsetName for imports/hydration: split an adsetName
// like "Ad Test #12 - Anti-Fake Dermato" back into its two parts. Falls
// back to putting everything in briefName if no separator found.
function parseBriefName(adsetName: string): { briefName: string; creativeName: string } {
  const m = adsetName.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (m) {
    return { briefName: m[1].trim(), creativeName: m[2].trim() };
  }
  return { briefName: adsetName.trim(), creativeName: "" };
}
