"use client";

// BriefBatchWizard — weekly "prepare 10 briefs at once" flow.
//
// Steps:
//   ① Briefs    — multi-add (brief name + creative name + avatar count)
//   ② Scripts   — per-brief card with the 3 hook scripts (V1, Hook 2, Hook 3)
//   ③ VO        — parallel ElevenLabs gen for the 30 hooks, live status grid
//   ④ Avatars   — opens per-brief in the existing wizard (skipped if all 0)
//   ⑤ Sync      — push every brief to Notion + Drive in parallel
//
// Persistence happens at the end of step 1 (briefs hit localStorage there).
// Steps 2-3 mutate the briefs in place via upsertBrief. Steps 4-5 just
// orchestrate existing flows.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Mic,
  Pause,
  Plus,
  RefreshCw,
  Sparkles,
  Users,
  X,
} from "lucide-react";

import {
  type Brief,
  loadBriefs,
  newBrief,
  upsertBrief,
} from "@/lib/briefs";
import { runVoiceoverBatch, type VoBatchJob } from "@/lib/voiceoverBatch";

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type StepId = 1 | 2 | 3 | 4 | 5;

type DraftRow = {
  /** Stable client-side id (used as React key — never persisted). */
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

// Same favorites as VoiceoverStudio — preselected to "first available".
const FAVORITE_VOICE_IDS = [
  "T4x5CtnhOiichhcqFzgg",
  "G0yjIg3xY8gEJZkHpjVm",
] as const;

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function BriefBatchWizard() {
  const router = useRouter();
  const [step, setStep] = useState<StepId>(1);

  // Step-1 rows. We always start with 5 empty rows so the user can dive
  // straight into typing without clicking "+ add" first.
  const [rows, setRows] = useState<DraftRow[]>(() =>
    Array.from({ length: 5 }, () => makeRow()),
  );

  // Committed briefs (after step 1). Indexed by row.briefId.
  const [briefs, setBriefs] = useState<Map<string, Brief>>(new Map());

  // Step-3 voice + VO state
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState<string>("");
  const [voState, setVoState] = useState<Map<string, VoCellState>>(new Map());
  const voAbortRef = useRef<AbortController | null>(null);

  // Step-5 sync state
  const [syncState, setSyncState] = useState<
    Map<string, { status: "idle" | "running" | "done" | "error"; error?: string; url?: string }>
  >(new Map());

  // Fetch voices once.
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
        /* offline / API down — picker will be empty */
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

  // Validate then commit each non-empty row to localStorage. Empty rows
  // (no brief name AND no creative name) are silently dropped.
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
      // If already committed, just keep.
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
  // Step 2 — Scripts
  // -----------------------------------------------------------------------

  const updateHookScript = useCallback(
    (briefId: string, hookId: string, script: string) => {
      const brief = briefs.get(briefId);
      if (!brief) return;
      const next: Brief = {
        ...brief,
        hooks: brief.hooks.map((h) =>
          h.id === hookId ? { ...h, hookScript: script } : h,
        ),
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
        if (existing?.status === "done") continue; // skip already generated
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

    // Mark all queued cells as running.
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
        // 'end'
        if (e.ok) {
          // Persist URL into the brief's hook.cutVoUrl
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

  const regenerateOne = useCallback(
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

  // -----------------------------------------------------------------------
  // Step 5 — Notion sync
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
    // Limit to 3 concurrent — Notion API is rate-limited at ~3 rps.
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
  // Render
  // -----------------------------------------------------------------------

  const committedBriefs = useMemo(
    () =>
      rows
        .filter((r) => r.briefId)
        .map((r) => briefs.get(r.briefId!))
        .filter((b): b is Brief => !!b),
    [briefs, rows],
  );

  const goNext = useCallback(() => {
    if (step === 1) {
      const { ok } = commitBriefs();
      if (ok === 0) return;
      setStep(2);
      return;
    }
    setStep((s) => Math.min(5, s + 1) as StepId);
  }, [commitBriefs, step]);

  const goBack = useCallback(() => {
    setStep((s) => Math.max(1, s - 1) as StepId);
  }, []);

  // Auto-skip step 4 forward if no avatars
  useEffect(() => {
    if (step !== 4) return;
    if (committedBriefs.length > 0 && committedBriefs.every((b) => b.avatarCount === 0)) {
      setStep(5);
    }
  }, [step, committedBriefs]);

  return (
    <div className="space-y-6">
      {/* Stepper */}
      <Stepper step={step} onPick={setStep} hasAvatars={committedBriefs.some((b) => b.avatarCount > 0)} />

      {/* Body — keyed on step so React remounts and the fade re-plays. */}
      <div key={step} className="min-h-[520px] pf-fade-in">
        {step === 1 && (
          <Step1Briefs
            rows={rows}
            onAdd={addRow}
            onRemove={removeRow}
            onPatch={patchRow}
          />
        )}
        {step === 2 && (
          <Step2Scripts briefs={committedBriefs} onUpdateScript={updateHookScript} />
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
            onRegenerate={regenerateOne}
            pendingCount={voJobs.length}
          />
        )}
        {step === 4 && (
          <Step4Avatars briefs={committedBriefs} router={router} />
        )}
        {step === 5 && (
          <Step5Sync briefs={committedBriefs} syncState={syncState} onSyncAll={syncAll} onSyncOne={syncOne} />
        )}
      </div>

      {/* Footer nav */}
      <div className="sticky bottom-4 z-10 bg-pf-bg/90 backdrop-blur-md border border-pf-border rounded-xl px-4 py-3 flex items-center justify-between">
        <button
          type="button"
          onClick={goBack}
          disabled={step === 1}
          className="inline-flex items-center gap-1.5 text-xs text-pf-dim hover:text-pf-text px-3 py-1.5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowLeft size={13} />
          Précédent
        </button>

        <div className="text-[11px] text-pf-muted">
          Étape {step} / 5
        </div>

        {step < 5 ? (
          <button
            type="button"
            onClick={goNext}
            disabled={step === 1 && rows.every((r) => !r.briefName.trim() && !r.creativeName.trim())}
            className="inline-flex items-center gap-1.5 bg-pf-accent text-pf-accent-fg font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-pf-accent/90 transition-colors"
          >
            {step === 1 ? `Valider (${rows.filter((r) => r.briefName.trim() || r.creativeName.trim()).length})` : "Suivant"}
            <ArrowRight size={13} />
          </button>
        ) : (
          <Link
            href="/briefs"
            className="inline-flex items-center gap-1.5 bg-pf-soft border border-pf-border hover:border-pf-accent rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          >
            Terminer
            <Check size={13} />
          </Link>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

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
    { id: 2, label: "Scripts", subtitle: "3 hooks par brief" },
    { id: 3, label: "Voix off", subtitle: "Génération bulk" },
    { id: 4, label: "Avatars", subtitle: hasAvatars ? "Par créatif" : "Skippé" },
    { id: 5, label: "Sync", subtitle: "Push Notion" },
  ];
  return (
    <div className="bg-pf-elev border border-pf-border rounded-xl px-2 py-2">
      <div className="flex items-stretch gap-1">
        {items.map((it, i) => {
          const active = step === it.id;
          const done = step > it.id;
          const skipped = it.id === 4 && !hasAvatars;
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => onPick(it.id)}
              disabled={skipped}
              className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-md transition-colors text-left ${
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
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${
                  active
                    ? "bg-pf-accent text-pf-accent-fg"
                    : done
                      ? "bg-pf-ok/20 text-pf-ok border border-pf-ok/40"
                      : "bg-pf-soft border border-pf-border text-pf-muted"
                }`}
              >
                {done ? <Check size={12} /> : i + 1}
              </span>
              <div className="min-w-0 hidden sm:block">
                <div className="text-xs font-semibold leading-tight truncate">{it.label}</div>
                <div className="text-[10px] text-pf-muted leading-tight truncate">
                  {it.subtitle}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Briefs
// ---------------------------------------------------------------------------

function Step1Briefs({
  rows,
  onAdd,
  onRemove,
  onPatch,
}: {
  rows: DraftRow[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  onPatch: (id: string, patch: Partial<DraftRow>) => void;
}) {
  // Tab from the last input of the last row should add a new row.
  const lastCreativeRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-4">
      <Intro
        title="Liste tes briefs pour la semaine"
        body="Une ligne = un brief = 3 hooks. Le nom du brief (ex. « Ad Test #12 ») + le nom de la créa (ex. « Anti-Fake Dermato ») formeront le titre du brief. Le nombre d'avatars est facultatif (0 = pas d'avatar IA)."
      />

      <div className="bg-pf-elev border border-pf-border rounded-xl divide-y divide-pf-border overflow-hidden">
        <div className="grid grid-cols-[1fr_1.4fr_120px_42px] gap-3 px-4 py-2.5 bg-pf-soft text-[10px] uppercase tracking-wider text-pf-muted font-semibold">
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
              className="grid grid-cols-[1fr_1.4fr_120px_42px] gap-3 px-4 py-2.5 items-center"
            >
              <input
                type="text"
                value={r.briefName}
                onChange={(e) => onPatch(r.rowId, { briefName: e.target.value })}
                placeholder={`Ad Test #${i + 1}`}
                className="bg-pf-bg border border-pf-border rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-pf-accent"
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
                className="bg-pf-bg border border-pf-border rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-pf-accent"
              />
              <AvatarCountPicker
                value={r.avatarCount}
                onChange={(n) => onPatch(r.rowId, { avatarCount: n })}
              />
              <button
                type="button"
                onClick={() => onRemove(r.rowId)}
                className="text-pf-muted hover:text-pf-danger w-8 h-8 rounded-md flex items-center justify-center hover:bg-pf-soft transition-colors"
                aria-label="Retirer la ligne"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onAdd}
        className="w-full bg-pf-elev border border-dashed border-pf-border hover:border-pf-accent rounded-xl px-4 py-3 text-sm text-pf-dim hover:text-pf-text flex items-center justify-center gap-1.5 transition-colors"
      >
        <Plus size={14} />
        Ajouter un brief
      </button>

      <div className="text-[11px] text-pf-muted text-center">
        Astuce : <kbd className="px-1.5 py-0.5 bg-pf-soft border border-pf-border rounded text-[10px]">Entrée</kbd> dans
        le champ « créa » ajoute automatiquement une nouvelle ligne.
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
    <div className="flex items-center gap-1 bg-pf-bg border border-pf-border rounded-md p-0.5">
      <button
        type="button"
        onClick={() => onChange(Math.max(0, value - 1))}
        className="w-6 h-6 rounded text-pf-muted hover:text-pf-text hover:bg-pf-soft flex items-center justify-center"
      >
        −
      </button>
      <span className="font-mono text-sm font-semibold w-6 text-center text-pf-text">
        {value}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(5, value + 1))}
        className="w-6 h-6 rounded text-pf-muted hover:text-pf-text hover:bg-pf-soft flex items-center justify-center"
      >
        +
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Scripts (accordion of briefs, only one open at a time)
// ---------------------------------------------------------------------------

function Step2Scripts({
  briefs,
  onUpdateScript,
}: {
  briefs: Brief[];
  onUpdateScript: (briefId: string, hookId: string, value: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(briefs[0]?.id ?? null);

  // Local script state — flushed to parent on blur to avoid re-renders per keystroke.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const b of briefs) for (const h of b.hooks) o[`${b.id}:${h.id}`] = h.hookScript;
    return o;
  });

  useEffect(() => {
    // Hydrate drafts when briefs change (e.g. step navigation).
    setDrafts((prev) => {
      const next = { ...prev };
      for (const b of briefs) {
        for (const h of b.hooks) {
          const key = `${b.id}:${h.id}`;
          if (next[key] === undefined) next[key] = h.hookScript;
        }
      }
      return next;
    });
  }, [briefs]);

  return (
    <div className="space-y-3">
      <Intro
        title="Saisis les 3 scripts par brief"
        body="Chaque brief a 3 hooks : V1 (la version originale, script complet) puis Hook 2 et Hook 3 (variations du hook d'ouverture). Tu peux ouvrir un brief à la fois pour rester concentré."
      />

      {briefs.map((b) => {
        const open = openId === b.id;
        const filled = b.hooks.every((h) => drafts[`${b.id}:${h.id}`]?.trim());
        return (
          <div
            key={b.id}
            className={`bg-pf-elev border rounded-xl overflow-hidden transition-colors ${
              open ? "border-pf-accent" : "border-pf-border"
            }`}
          >
            <button
              type="button"
              onClick={() => setOpenId(open ? null : b.id)}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-pf-soft transition-colors"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {open ? (
                  <ChevronDown size={16} className="text-pf-accent shrink-0" />
                ) : (
                  <ChevronRight size={16} className="text-pf-muted shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate">{b.adsetName}</div>
                  <div className="text-[11px] text-pf-muted font-mono">
                    {b.hooks.filter((h) => drafts[`${b.id}:${h.id}`]?.trim()).length} / 3 scripts
                  </div>
                </div>
              </div>
              {filled && (
                <span className="text-[10px] font-bold uppercase tracking-wider bg-pf-ok/20 text-pf-ok rounded px-1.5 py-0.5 shrink-0">
                  ✓ Complet
                </span>
              )}
            </button>

            {open && (
              <div className="border-t border-pf-border px-4 py-4 space-y-3">
                {b.hooks.map((h) => {
                  const key = `${b.id}:${h.id}`;
                  const label = h.index === 1 ? "V1 (Original — script complet)" : `Hook ${h.index} (variation d'ouverture)`;
                  return (
                    <div key={h.id}>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-[11px] uppercase tracking-wider text-pf-muted font-semibold">
                          {label}
                        </label>
                        <span className="text-[10px] text-pf-muted font-mono">
                          {(drafts[key] ?? "").length} chars
                        </span>
                      </div>
                      <textarea
                        value={drafts[key] ?? ""}
                        onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                        onBlur={() => onUpdateScript(b.id, h.id, drafts[key] ?? "")}
                        placeholder={h.index === 1
                          ? "Écris le script complet (3-30s de VO)…"
                          : "Variation du hook seule (1-3 phrases). Le reste du script reste celui de V1."
                        }
                        rows={h.index === 1 ? 6 : 3}
                        className="w-full bg-pf-bg border border-pf-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-pf-accent leading-relaxed resize-y"
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Voice-over batch
// ---------------------------------------------------------------------------

function Step3Voiceover({
  briefs,
  voices,
  voiceId,
  onVoiceChange,
  voState,
  onRunAll,
  onCancel,
  onRegenerate,
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
  pendingCount: number;
}) {
  // Aggregate counts
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

  const allDone = totals.total > 0 && totals.done === totals.total;
  const anyRunning = totals.running > 0;

  return (
    <div className="space-y-4">
      <Intro
        title="Génère toutes les voix off en parallèle"
        body="Une voix par défaut s'applique à tout le batch. Tu peux relancer une ligne avec une autre voix si besoin. Le résultat est écrit directement dans le brief (cutVo)."
      />

      {/* Top control bar */}
      <div className="bg-pf-elev border border-pf-border rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-[220px]">
          <Mic size={14} className="text-pf-accent" />
          <select
            value={voiceId}
            onChange={(e) => onVoiceChange(e.target.value)}
            className="flex-1 bg-pf-bg border border-pf-border rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-pf-accent"
          >
            {voices.length === 0 && <option value="">— Chargement des voix —</option>}
            {voices.map((v) => (
              <option key={v.voiceId} value={v.voiceId}>
                {v.name}
                {v.category ? ` · ${v.category}` : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5 text-xs">
          <Pill label={`${totals.done} / ${totals.total} done`} tone={allDone ? "ok" : "neutral"} />
          {anyRunning && <Pill label={`${totals.running} en cours`} tone="run" />}
          {totals.error > 0 && <Pill label={`${totals.error} erreur${totals.error > 1 ? "s" : ""}`} tone="err" />}
        </div>

        {anyRunning ? (
          <button
            type="button"
            onClick={onCancel}
            className="bg-pf-soft border border-pf-border hover:border-pf-danger text-pf-text hover:text-pf-danger rounded-md px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors"
          >
            <Pause size={12} />
            Annuler
          </button>
        ) : (
          <button
            type="button"
            onClick={onRunAll}
            disabled={pendingCount === 0}
            className="bg-pf-accent text-pf-accent-fg font-semibold rounded-md px-4 py-1.5 text-xs inline-flex items-center gap-1.5 disabled:opacity-40 hover:bg-pf-accent/90 transition-colors"
          >
            <Sparkles size={12} />
            {pendingCount === 0 ? "Tout est généré" : `Générer ${pendingCount}`}
          </button>
        )}
      </div>

      {/* Rows */}
      <div className="bg-pf-elev border border-pf-border rounded-xl overflow-hidden">
        <div className="grid grid-cols-[1.6fr_72px_1fr_180px_120px] gap-3 px-4 py-2.5 bg-pf-soft text-[10px] uppercase tracking-wider text-pf-muted font-semibold border-b border-pf-border">
          <span>Brief</span>
          <span>Hook</span>
          <span>Statut</span>
          <span>Player</span>
          <span className="text-right">Action</span>
        </div>
        <div className="divide-y divide-pf-border">
          {briefs.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-pf-muted">
              Aucun brief avec un script. Reviens à l&apos;étape 2.
            </div>
          )}
          {briefs.map((b) =>
            b.hooks.map((h) => {
              if (!h.hookScript.trim()) return null;
              const key = `${b.id}:${h.id}`;
              const s = voState.get(key);
              const url = s?.url || h.cutVoUrl;
              const status: VoCellStatus = s?.status ?? (url ? "done" : "idle");
              const hookLabel = h.index === 1 ? "V1" : `H${h.index}`;
              return (
                <div
                  key={key}
                  className="grid grid-cols-[1.6fr_72px_1fr_180px_120px] gap-3 px-4 py-2.5 items-center text-xs"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{b.adsetName}</div>
                    <div className="text-[10px] text-pf-muted line-clamp-1">
                      {h.hookScript.slice(0, 80)}
                      {h.hookScript.length > 80 ? "…" : ""}
                    </div>
                  </div>
                  <span className="text-pf-text font-semibold font-mono">{hookLabel}</span>
                  <StatusCell status={status} error={s?.error} />
                  <div>
                    {url ? (
                      // eslint-disable-next-line jsx-a11y/media-has-caption
                      <audio controls src={url} className="w-full h-7" />
                    ) : (
                      <span className="text-pf-muted">—</span>
                    )}
                  </div>
                  <div className="text-right">
                    <button
                      type="button"
                      onClick={() => onRegenerate(b.id, h.id)}
                      disabled={status === "running"}
                      className="inline-flex items-center gap-1 text-pf-dim hover:text-pf-accent border border-pf-border hover:border-pf-accent rounded-md px-2 py-1 text-[11px] disabled:opacity-40 transition-colors"
                    >
                      {status === "running" ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <RefreshCw size={11} />
                      )}
                      {url ? "Re-gen" : "Gen"}
                    </button>
                  </div>
                </div>
              );
            }),
          )}
        </div>
      </div>
    </div>
  );
}

function StatusCell({ status, error }: { status: VoCellStatus; error?: string }) {
  if (status === "done") {
    return (
      <span className="inline-flex items-center gap-1 text-pf-ok">
        <Check size={12} className="pf-success-pop" />
        Done
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 text-pf-warn">
        <span className="w-1.5 h-1.5 rounded-full bg-pf-warn pf-pulse-dot inline-block" />
        En cours…
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-pf-danger" title={error}>
        <X size={12} />
        Erreur
      </span>
    );
  }
  return <span className="text-pf-muted">Idle</span>;
}

// ---------------------------------------------------------------------------
// Step 4 — Avatars (per-brief deep-link to the existing wizard)
// ---------------------------------------------------------------------------

type Router = ReturnType<typeof useRouter>;

function Step4Avatars({ briefs, router }: { briefs: Brief[]; router: Router }) {
  const withAvatars = briefs.filter((b) => b.avatarCount > 0);
  if (withAvatars.length === 0) {
    return (
      <div className="bg-pf-elev border border-pf-border rounded-xl p-8 text-center">
        <Sparkles size={28} className="mx-auto text-pf-accent mb-3" />
        <h3 className="text-base font-semibold mb-1">Aucun brief avec avatar IA</h3>
        <p className="text-xs text-pf-dim max-w-md mx-auto">
          Tu as choisi 0 avatar pour tous les briefs de ce batch. On passe directement à la sync.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Intro
        title="Configure les avatars (créa par créa)"
        body="Les avatars sont l'étape la plus chirurgicale : image de référence, prompt lipsync, validation par hook. On ouvre le wizard fine d'un brief à la fois."
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {withAvatars.map((b) => {
          const totalSlots = b.avatarCount * 3;
          const doneSlots = b.hooks.reduce(
            (acc, h) =>
              acc + h.avatars.filter((a) => a.lipsyncStatus === "done" && a.lipsyncVideoUrl).length,
            0,
          );
          const pct = totalSlots === 0 ? 0 : Math.round((doneSlots / totalSlots) * 100);
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => router.push(`/briefs/${b.id}`)}
              className="text-left bg-pf-elev border border-pf-border hover:border-pf-accent rounded-xl p-4 transition-colors group"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="w-9 h-9 rounded-md bg-pf-accent/15 border border-pf-accent/30 text-pf-accent flex items-center justify-center">
                  <Users size={15} />
                </div>
                <span className="text-[10px] text-pf-muted font-mono">
                  {doneSlots}/{totalSlots}
                </span>
              </div>
              <div className="text-sm font-semibold truncate">{b.adsetName}</div>
              <div className="text-[11px] text-pf-muted font-mono mt-0.5">
                3 hooks × {b.avatarCount} avatars
              </div>
              <div className="mt-3 h-1 bg-pf-soft rounded-full overflow-hidden">
                <div
                  className="h-full bg-pf-accent transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-3 text-[11px] text-pf-accent font-semibold flex items-center gap-1">
                Configurer
                <ArrowRight size={12} className="group-hover:translate-x-0.5 transition-transform" />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 5 — Sync
// ---------------------------------------------------------------------------

function Step5Sync({
  briefs,
  syncState,
  onSyncAll,
  onSyncOne,
}: {
  briefs: Brief[];
  syncState: Map<
    string,
    { status: "idle" | "running" | "done" | "error"; error?: string; url?: string }
  >;
  onSyncAll: () => void;
  onSyncOne: (b: Brief) => void;
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
    <div className="space-y-4">
      <Intro
        title="Pousse tout vers Notion + Drive"
        body="Chaque brief crée 3 pages Notion (une par hook). Les voix off et avatars sont uploadés vers Drive selon ton arborescence. Lien Notion visible dès qu'un brief est sync."
      />

      <div className="bg-pf-elev border border-pf-border rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5 text-xs flex-1">
          <Pill label={`${totals.done} / ${totals.total} sync`} tone={totals.done === totals.total ? "ok" : "neutral"} />
          {totals.running > 0 && <Pill label={`${totals.running} en cours`} tone="run" />}
          {totals.error > 0 && <Pill label={`${totals.error} erreur${totals.error > 1 ? "s" : ""}`} tone="err" />}
        </div>
        <button
          type="button"
          onClick={onSyncAll}
          disabled={totals.running > 0}
          className="bg-pf-accent text-pf-accent-fg font-semibold rounded-md px-4 py-1.5 text-xs inline-flex items-center gap-1.5 disabled:opacity-40 hover:bg-pf-accent/90 transition-colors"
        >
          <Sparkles size={12} />
          Push tout vers Notion
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {briefs.map((b) => {
          const s = syncState.get(b.id);
          const status = s?.status ?? "idle";
          const filledHooks = b.hooks.filter((h) => h.hookScript.trim()).length;
          const filledVo = b.hooks.filter((h) => h.cutVoUrl).length;
          return (
            <div
              key={b.id}
              className={`bg-pf-elev border rounded-xl p-4 ${
                status === "done"
                  ? "border-pf-ok/50"
                  : status === "error"
                    ? "border-pf-danger/50"
                    : "border-pf-border"
              }`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="text-sm font-semibold truncate flex-1 min-w-0">
                  {b.adsetName}
                </div>
                <StatusCell status={status === "idle" ? "idle" : status === "done" ? "done" : status === "running" ? "running" : "error"} error={s?.error} />
              </div>
              <div className="space-y-1.5 mb-3">
                <Row label="Scripts" value={`${filledHooks} / 3`} done={filledHooks === 3} />
                <Row label="Voix off" value={`${filledVo} / 3`} done={filledVo === 3} />
                {b.avatarCount > 0 && (
                  <Row
                    label="Avatars"
                    value={`${b.hooks.reduce(
                      (a, h) =>
                        a + h.avatars.filter((x) => x.lipsyncStatus === "done").length,
                      0,
                    )} / ${b.avatarCount * 3}`}
                    done={b.hooks.every((h) =>
                      h.avatars.every((a) => a.lipsyncStatus === "done"),
                    )}
                  />
                )}
              </div>

              {s?.url ? (
                <Link
                  href={s.url}
                  target="_blank"
                  className="inline-flex items-center gap-1 text-xs text-pf-accent hover:underline mb-2"
                >
                  Voir la page Notion <ExternalLink size={11} />
                </Link>
              ) : null}

              {s?.error ? (
                <div className="text-[11px] text-pf-danger bg-pf-danger/10 border border-pf-danger/30 rounded-md px-2 py-1.5 mb-2">
                  {s.error}
                </div>
              ) : null}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onSyncOne(b)}
                  disabled={status === "running"}
                  className="flex-1 text-xs bg-pf-soft border border-pf-border hover:border-pf-accent rounded-md py-1.5 disabled:opacity-40 transition-colors inline-flex items-center justify-center gap-1.5"
                >
                  {status === "running" ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <RefreshCw size={11} />
                  )}
                  {status === "done" ? "Re-sync" : "Sync"}
                </button>
                <Link
                  href={`/briefs/${b.id}`}
                  className="text-xs text-pf-dim hover:text-pf-text border border-pf-border hover:border-pf-accent rounded-md px-2.5 py-1.5 transition-colors"
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

function Row({ label, value, done }: { label: string; value: string; done: boolean }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-pf-muted">{label}</span>
      <span className={`font-mono ${done ? "text-pf-ok" : "text-pf-dim"}`}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Intro({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-pf-soft/40 border border-pf-border rounded-xl px-4 py-3">
      <div className="text-sm font-semibold mb-0.5">{title}</div>
      <p className="text-xs text-pf-dim leading-relaxed">{body}</p>
    </div>
  );
}

function Pill({
  label,
  tone,
}: {
  label: string;
  tone: "ok" | "run" | "err" | "neutral";
}) {
  const c =
    tone === "ok"
      ? "bg-pf-ok/15 text-pf-ok border-pf-ok/40"
      : tone === "run"
        ? "bg-pf-warn/15 text-pf-warn border-pf-warn/40"
        : tone === "err"
          ? "bg-pf-danger/15 text-pf-danger border-pf-danger/40"
          : "bg-pf-soft text-pf-dim border-pf-border";
  return (
    <span className={`inline-flex items-center text-[11px] font-mono rounded-md px-2 py-0.5 border ${c}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function makeRow(): DraftRow {
  return {
    rowId: Math.random().toString(36).slice(2, 10),
    briefName: "",
    creativeName: "",
    avatarCount: 0,
  };
}

function composeAdsetName(briefName: string, creativeName: string): string {
  const a = briefName.trim();
  const b = creativeName.trim();
  if (a && b) return `${a} — ${b}`;
  return a || b || "Brief sans titre";
}

// Hydrate briefs that already exist in localStorage. The wizard is
// instantiated fresh on every page mount; loadBriefs() makes the picker
// re-pick up a session that was interrupted (refresh / nav away).
//
// NOTE: this is currently unused — we always start with empty rows. Kept
// as a hook for future "resume in-flight batch" flows.
export function _unusedLoadAllBriefsForBatch(): Brief[] {
  return loadBriefs();
}

