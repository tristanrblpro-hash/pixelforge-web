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
  Users,
  Video,
  X,
} from "lucide-react";

import {
  type AvatarSlot,
  type Brief,
  loadBriefs,
  newBrief,
  setAttachTarget,
  upsertBrief,
} from "@/lib/briefs";
import { runVoiceoverBatch, type VoBatchJob } from "@/lib/voiceoverBatch";
import { GdocImportModal } from "@/components/GdocImportModal";

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type StepId = 1 | 2 | 3 | 4 | 5 | 6;

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

const SESSION_STATE_KEY = "pf:batchWizard:v1";

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
    const raw = window.sessionStorage.getItem(SESSION_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedState;
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
      setLipsyncState(new Map(persisted.lipsyncState));
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
    (briefId: string, hookId: string, patch: { hookScript?: string; notes?: string }) => {
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
        });
      }
    }
    return jobs;
  }, [briefs, rows, voState, voiceId, voices]);

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
            modelId: "eleven_multilingual_v2",
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
    [briefs, voiceId, voices],
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

  // -----------------------------------------------------------------------
  // Step 5 — Lipsync batch
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

  const startLsPolling = useCallback(
    (id: string, batchId: string, briefId: string, hookId: string, avatarId: string) => {
      stopLsPolling(id);
      const poll = async () => {
        try {
          const r = await fetch(`/api/batch/${batchId}/status`, { cache: "no-store" });
          if (!r.ok) return;
          const data = (await r.json()) as {
            items?: Array<{ status: string; output_url?: string | null; error?: string | null }>;
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
            stopLsPolling(id);
          } else if (item.status === "failed") {
            setLipsyncState((s) => {
              const nm = new Map(s);
              nm.set(id, { status: "error", error: item.error || "Kling failed" });
              return nm;
            });
            stopLsPolling(id);
          }
        } catch {
          /* blip */
        }
      };
      const i = setInterval(poll, 6000);
      lsPollersRef.current.set(id, i);
      void poll();
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
        startLsPolling(job.id, data.batch_id, job.briefId, job.hookId, job.avatar.id);
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

  const runLipsyncBatch = useCallback(async () => {
    if (lipsyncJobs.length === 0) return;
    lsAbortRef.current?.abort();
    const ac = new AbortController();
    lsAbortRef.current = ac;
    const concurrency = 3;
    const queue = lipsyncJobs.slice();
    const worker = async () => {
      while (queue.length > 0 && !ac.signal.aborted) {
        const job = queue.shift();
        if (!job) break;
        await runOneLipsync(job);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }, [lipsyncJobs, runOneLipsync]);

  const cancelLipsyncBatch = useCallback(() => {
    lsAbortRef.current?.abort();
    // Note: in-flight polling continues — Kling jobs keep running on their side.
  }, []);

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

  const maxStep: StepId = 6;
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

  // Auto-skip steps 4+5 (Images / Lipsync) if no brief uses avatars.
  useEffect(() => {
    if ((step === 4 || step === 5) && committedBriefs.length > 0 && !hasAvatars) {
      setStep(6);
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
          <Step2Scripts
            briefs={committedBriefs}
            onUpdateHook={updateHookField}
            onUpdateBrief={updateBriefField}
          />
        )}
        {step === 3 && (
          <Step3Voiceover
            briefs={committedBriefs}
            voices={voices}
            voiceId={voiceId}
            onVoiceChange={setVoiceId}
            voState={voState}
            onRunAll={runBatchVo}
            onCancel={cancelBatchVo}
            onRegenerate={regenerateVo}
            onCutBlanks={handoffCut}
            pendingCount={voJobs.length}
          />
        )}
        {step === 4 && (
          <Step4Images
            briefs={committedBriefs}
            onOpenBrief={(id) => router.push(`/briefs/${id}`)}
            onUseHookVoForAvatars={useHookVoForAvatars}
          />
        )}
        {step === 5 && (
          <Step5Lipsync
            briefs={committedBriefs}
            lipsyncState={lipsyncState}
            onRunAll={runLipsyncBatch}
            onCancel={cancelLipsyncBatch}
            pendingCount={lipsyncJobs.length}
            anyRunning={Array.from(lipsyncState.values()).some((s) => s.status === "running")}
            onOpenBrief={(id) => router.push(`/briefs/${id}`)}
          />
        )}
        {step === 6 && (
          <Step6Sync
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
    { id: 2, label: "Scripts", subtitle: "V1 + 2 hooks" },
    { id: 3, label: "Voix off", subtitle: "Bulk + cut" },
    { id: 4, label: "Images", subtitle: hasAvatars ? "Par avatar" : "Skippé" },
    { id: 5, label: "Lipsync", subtitle: hasAvatars ? "Bulk Kling" : "Skippé" },
    { id: 6, label: "Sync", subtitle: "Notion" },
  ];
  return (
    <div className="bg-pf-elev border border-pf-border rounded-2xl px-2 py-2">
      <div className="flex items-stretch gap-1">
        {items.map((it, i) => {
          const active = step === it.id;
          const done = step > it.id;
          const skipped = (it.id === 4 || it.id === 5) && !hasAvatars;
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
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-1 bg-pf-bg border border-pf-border rounded-lg p-1">
      <button
        type="button"
        onClick={() => onChange(Math.max(0, value - 1))}
        className="w-8 h-8 rounded-md text-pf-muted hover:text-pf-text hover:bg-pf-soft flex items-center justify-center text-lg"
      >
        −
      </button>
      <span className="font-mono text-lg font-bold w-8 text-center text-pf-text">
        {value}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(5, value + 1))}
        className="w-8 h-8 rounded-md text-pf-muted hover:text-pf-text hover:bg-pf-soft flex items-center justify-center text-lg"
      >
        +
      </button>
    </div>
  );
}

// ===========================================================================
// Step 2 — Scripts + optional notes + creative ref
// ===========================================================================

function Step2Scripts({
  briefs,
  onUpdateHook,
  onUpdateBrief,
}: {
  briefs: Brief[];
  onUpdateHook: (briefId: string, hookId: string, patch: { hookScript?: string; notes?: string }) => void;
  onUpdateBrief: (briefId: string, patch: { creativeRef?: string; notes?: string }) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(briefs[0]?.id ?? null);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const b of briefs) {
      for (const h of b.hooks) o[`${b.id}:${h.id}:script`] = h.hookScript;
      for (const h of b.hooks) o[`${b.id}:${h.id}:notes`] = h.notes ?? "";
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
          if (next[k1] === undefined) next[k1] = h.hookScript;
          if (next[k2] === undefined) next[k2] = h.notes ?? "";
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
                    {b.hooks.filter((h) => drafts[`${b.id}:${h.id}:script`]?.trim()).length} / 3 scripts
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
                  const nKey = `${b.id}:${h.id}`;
                  const showNotes = notesOpen[nKey] ?? !!drafts[nk]?.trim();
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
                      <button
                        type="button"
                        onClick={() => setNotesOpen((m) => ({ ...m, [nKey]: !showNotes }))}
                        className="text-xs text-pf-muted hover:text-pf-text inline-flex items-center gap-1"
                      >
                        {showNotes ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        Note monteur {showNotes ? "" : "(optionnelle)"}
                      </button>
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

function Step3Voiceover({
  briefs,
  voices,
  voiceId,
  onVoiceChange,
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

function Step4Images({
  briefs,
  onOpenBrief,
  onUseHookVoForAvatars,
}: {
  briefs: Brief[];
  onOpenBrief: (id: string) => void;
  onUseHookVoForAvatars: (briefId: string) => void;
}) {
  // A brief is in scope here if ANY of its hooks needs at least one avatar,
  // not if brief.avatarCount > 0 — those two diverge when per-hook counts
  // differ (e.g. V1=2, H2=1, H3=0 → brief.avatarCount=2 but the user only
  // has 3 avatars total, not 6).
  const withAvatars = briefs.filter((b) =>
    b.hooks.some((h) => h.avatars.length > 0),
  );

  if (withAvatars.length === 0) {
    return (
      <div className="bg-pf-elev border border-pf-border rounded-2xl p-10 text-center">
        <Sparkles size={32} className="mx-auto text-pf-accent mb-4" />
        <h3 className="text-lg font-bold mb-2">Aucun brief avec avatar IA</h3>
        <p className="text-sm text-pf-dim max-w-md mx-auto">
          Tu as choisi 0 avatar pour tous les briefs. On passe directement au sync.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Intro
        title="Assigne une image + une voix off à chaque avatar"
        body="Pour le lipsync il faut UNE image + UN clip vocal par avatar. Génère tes images dans Prompts et tes voix off dans Voiceover, puis utilise « 📎 Rattacher au brief » sur chaque résultat. Tu peux aussi cloner la voix off du hook sur tous ses avatars en un clic."
      />

      <div className="flex flex-wrap items-center gap-2">
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {withAvatars.map((b) => {
          // True totals: sum of hook.avatars.length across the 3 hooks.
          const totalSlots = b.hooks.reduce((acc, h) => acc + h.avatars.length, 0);
          const imagesAssigned = b.hooks.reduce(
            (acc, h) => acc + h.avatars.filter((a) => a.imageUrl).length,
            0,
          );
          const voAssigned = b.hooks.reduce(
            (acc, h) => acc + h.avatars.filter((a) => a.voClipUrl).length,
            0,
          );
          const pct = totalSlots === 0 ? 0 : Math.round((imagesAssigned / totalSlots) * 100);
          const allReady =
            totalSlots > 0 && imagesAssigned === totalSlots && voAssigned === totalSlots;
          // Per-hook breakdown for the title — only show non-zero hooks.
          const breakdown = b.hooks
            .map((h) => `${h.index === 1 ? "V1" : `H${h.index}`}=${h.avatars.length}`)
            .filter((s) => !s.endsWith("=0"))
            .join(" · ");
          // The "Use hook VO for avatars" shortcut is only useful when at
          // least one hook has its cutVoUrl AND at least one avatar
          // without a clip yet — otherwise it's a no-op.
          const canCloneHookVo = b.hooks.some(
            (h) =>
              h.cutVoUrl && h.avatars.some((a) => !a.voClipUrl),
          );
          return (
            <div
              key={b.id}
              className={`bg-pf-elev border rounded-2xl p-5 transition-colors ${
                allReady ? "border-pf-ok/40" : "border-pf-border"
              }`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="w-11 h-11 rounded-xl bg-pf-accent/15 border border-pf-accent/30 text-pf-accent flex items-center justify-center">
                  <Users size={18} />
                </div>
                {allReady ? <BadgeOK label="Complet" /> : <Pill label={`${pct}%`} tone="neutral" />}
              </div>
              <div className="text-base font-bold truncate">{b.adsetName}</div>
              <div className="text-sm text-pf-muted font-mono mt-1">
                {totalSlots} avatar{totalSlots > 1 ? "s" : ""}
                {breakdown && ` · ${breakdown}`}
              </div>

              <div className="mt-4 space-y-1.5">
                <ChecklineRow label="Images" done={imagesAssigned} total={totalSlots} />
                <ChecklineRow label="Clips vocaux avatar" done={voAssigned} total={totalSlots} />
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onOpenBrief(b.id)}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold bg-pf-accent text-pf-accent-fg rounded-lg px-3.5 py-2 hover:bg-pf-accent/90 transition-colors"
                >
                  Ouvrir
                  <ArrowRight size={13} />
                </button>
                {canCloneHookVo && (
                  <button
                    type="button"
                    onClick={() => onUseHookVoForAvatars(b.id)}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-pf-dim hover:text-pf-text border border-pf-border hover:border-pf-accent rounded-lg px-3 py-2 transition-colors"
                    title="Copie la voix off de chaque hook sur tous ses avatars (sans toucher aux clips déjà rattachés)."
                  >
                    <Mic size={13} />
                    Utiliser la VO du hook
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
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

function Step5Lipsync({
  briefs,
  lipsyncState,
  onRunAll,
  onCancel,
  pendingCount,
  anyRunning,
  onOpenBrief,
}: {
  briefs: Brief[];
  lipsyncState: Map<string, LsCellState>;
  onRunAll: () => void;
  onCancel: () => void;
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
        title="Génère tous les lipsyncs"
        body="On envoie à Kling chaque (image + voix off) prêt(e). Les vidéos s'attribuent automatiquement au bon brief. Compte ~1 min par lipsync, jusqu'à 3 en parallèle."
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
          >
            <Sparkles size={14} />
            {pendingCount === 0
              ? totals.notReady > 0
                ? "Avatars incomplets — assigne images + voix"
                : "Tout est généré ✓"
              : `Générer les ${pendingCount} lipsyncs`}
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {withAvatars.map((b) => {
          const slots: { hookId: string; av: AvatarSlot; hookLabel: string }[] = [];
          for (const h of b.hooks) {
            const hookLabel = h.index === 1 ? "V1" : `H${h.index}`;
            for (const av of h.avatars) {
              slots.push({ hookId: h.id, av, hookLabel });
            }
          }
          const briefDone = slots.every(
            (s) => s.av.lipsyncStatus === "done" && s.av.lipsyncVideoUrl,
          );
          return (
            <div
              key={b.id}
              className={`bg-pf-elev border rounded-2xl overflow-hidden ${
                briefDone ? "border-pf-ok/40" : "border-pf-border"
              }`}
            >
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-pf-border bg-pf-soft/40">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-pf-accent/15 border border-pf-accent/30 text-pf-accent flex items-center justify-center shrink-0">
                    <Video size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-base font-bold truncate">{b.adsetName}</div>
                    <div className="text-sm text-pf-muted font-mono">
                      {slots.filter((s) => s.av.lipsyncStatus === "done").length} / {slots.length}{" "}
                      lipsyncs
                    </div>
                  </div>
                </div>
                {briefDone ? (
                  <BadgeOK label="OK" />
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpenBrief(b.id)}
                    className="text-sm text-pf-accent hover:underline inline-flex items-center gap-1"
                  >
                    Détails
                    <ArrowRight size={12} />
                  </button>
                )}
              </div>

              <div className="divide-y divide-pf-border">
                {slots.map(({ hookId, av, hookLabel }) => {
                  const key = `${b.id}:${hookId}:${av.id}`;
                  const s = lipsyncState.get(key);
                  const url = av.lipsyncVideoUrl || s?.url;
                  const status: LsCellStatus =
                    av.lipsyncStatus === "done"
                      ? "done"
                      : (s?.status ?? (av.imageUrl && av.voClipUrl ? "idle" : "idle"));
                  const ready = av.imageUrl && av.voClipUrl;
                  return (
                    <div key={key} className="px-5 py-3 flex items-center gap-3">
                      <span className="text-sm font-bold font-mono text-pf-text bg-pf-soft border border-pf-border rounded-md px-2 py-0.5 shrink-0">
                        {hookLabel}
                      </span>
                      <span className="text-sm truncate flex-1">{av.label}</span>
                      {!ready ? (
                        <Pill label="Image/VO manquant" tone="muted" />
                      ) : status === "done" ? (
                        <span className="inline-flex items-center gap-1.5 text-pf-ok text-sm">
                          <Check size={14} className="pf-success-pop" />
                          Done
                        </span>
                      ) : status === "running" ? (
                        <span className="inline-flex items-center gap-2 text-pf-warn text-sm">
                          <span className="w-2 h-2 rounded-full bg-pf-warn pf-pulse-dot" />
                          En cours
                        </span>
                      ) : status === "error" ? (
                        <span className="text-pf-danger text-sm" title={s?.error}>
                          Erreur
                        </span>
                      ) : (
                        <span className="text-pf-muted text-sm">Idle</span>
                      )}
                      {url && (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-pf-accent text-sm hover:underline inline-flex items-center gap-1"
                        >
                          Voir
                          <ExternalLink size={11} />
                        </a>
                      )}
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
// Step 6 — Sync (was 5)
// ===========================================================================

function Step6Sync({
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
                    3 hooks
                    {totalLs > 0 ? ` · ${totalLs} avatar${totalLs > 1 ? "s" : ""}` : ""}
                  </div>
                </div>
                <div className="shrink-0">
                  <SyncStatusBadge status={status} error={s?.error} />
                </div>
              </div>

              <div className="space-y-2 my-4">
                <ChecklineRow label="Scripts" done={filledHooks} total={3} />
                <ChecklineRow label="Voix off" done={filledVo} total={3} />
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
