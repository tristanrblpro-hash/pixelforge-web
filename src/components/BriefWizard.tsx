"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Download,
  ExternalLink,
  ImagePlus,
  Loader2,
  Mic,
  Minus,
  Plus,
  Scissors,
  Wand2,
  X,
} from "lucide-react";

import {
  type AvatarSlot,
  type Brief,
  type HookBrief,
  DEFAULT_LIPSYNC_PROMPT,
  loadBrief,
  setAttachTarget,
  suggestAdsetName,
  syncAvatarCount,
  upsertBrief,
} from "@/lib/briefs";

type Props = { id: string };

type StepKind =
  | "setup"
  | "hook-script"
  | "hook-vo"
  | "hook-avatars"
  | "hook-summary"
  | "final";

type Step = {
  id: string;
  kind: StepKind;
  shortLabel: string;
  hookId?: string;
};

type Phase = {
  id: string;
  label: string;
  // "Version 1" or "Hook N" — the label inside each phase tab.
  hookId?: string;
  steps: Step[];
};

// Hook index 0 is the FULL ad (Version 1). Indices 1 and 2 are just hook
// variations that get spliced before/after V1 — they reuse the same
// sub-step structure but with shorter scripts and (usually) fewer avatars.
function phaseLabel(hookIndex: number): string {
  return hookIndex === 1 ? "Version 1" : `Hook ${hookIndex}`;
}

function computePhases(brief: Brief): Phase[] {
  const phases: Phase[] = [];
  for (let i = 0; i < brief.hooks.length; i++) {
    const hook = brief.hooks[i];
    const isV1 = i === 0;
    const steps: Step[] = [];
    if (isV1) {
      // Setup lives at the start of V1 (it applies to the whole adset).
      steps.push({ id: "setup", kind: "setup", shortLabel: "Setup" });
    }
    steps.push({
      id: `${hook.id}-script`,
      kind: "hook-script",
      shortLabel: "Script",
      hookId: hook.id,
    });
    steps.push({
      id: `${hook.id}-vo`,
      kind: "hook-vo",
      shortLabel: "Voix off",
      hookId: hook.id,
    });
    if (brief.template === "avatar") {
      steps.push({
        id: `${hook.id}-avatars`,
        kind: "hook-avatars",
        shortLabel: "Avatars",
        hookId: hook.id,
      });
    }
    steps.push({
      id: `${hook.id}-summary`,
      kind: "hook-summary",
      shortLabel: "Récap",
      hookId: hook.id,
    });
    phases.push({
      id: `phase-${i}`,
      label: phaseLabel(hook.index),
      hookId: hook.id,
      steps,
    });
  }
  // Final brief summary.
  phases.push({
    id: "phase-final",
    label: "Brief final",
    steps: [{ id: "final", kind: "final", shortLabel: "Récap final" }],
  });
  return phases;
}

// Flatten all phases' steps for linear navigation (Next/Previous cross
// phase boundaries naturally).
function flattenSteps(phases: Phase[]): Step[] {
  return phases.flatMap((p) => p.steps);
}

export function BriefWizard({ id }: Props) {
  const router = useRouter();
  const [brief, setBrief] = useState<Brief | null>(null);
  const [notFound, setNotFound] = useState(false);
  const pollers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  // Hydrate
  useEffect(() => {
    const b = loadBrief(id);
    if (b) setBrief(b);
    else setNotFound(true);
  }, [id]);

  // Persist on every change.
  const lastSaved = useRef<Brief | null>(null);
  useEffect(() => {
    if (!brief) return;
    if (lastSaved.current === brief) return;
    lastSaved.current = brief;
    upsertBrief(brief);
  }, [brief]);

  // Cleanup pollers on unmount.
  useEffect(() => {
    const cur = pollers.current;
    return () => {
      cur.forEach((t) => clearInterval(t));
      cur.clear();
    };
  }, []);

  // ---------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------
  const update = useCallback((patch: Partial<Brief>) => {
    setBrief((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const updateHook = useCallback((hookId: string, patch: Partial<HookBrief>) => {
    setBrief((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        hooks: prev.hooks.map((h) => (h.id === hookId ? { ...h, ...patch } : h)),
      };
    });
  }, []);

  const updateAvatar = useCallback(
    (hookId: string, avatarId: string, patch: Partial<AvatarSlot>) => {
      setBrief((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          hooks: prev.hooks.map((h) =>
            h.id === hookId
              ? {
                  ...h,
                  avatars: h.avatars.map((a) =>
                    a.id === avatarId ? { ...a, ...patch } : a,
                  ),
                }
              : h,
          ),
        };
      });
    },
    [],
  );

  // ---------------------------------------------------------------------
  // Lipsync polling
  // ---------------------------------------------------------------------
  const stopPolling = useCallback((avatarId: string) => {
    const t = pollers.current.get(avatarId);
    if (t) {
      clearInterval(t);
      pollers.current.delete(avatarId);
    }
  }, []);

  const startPollingAvatar = useCallback(
    (hookId: string, avatarId: string, batchId: string) => {
      stopPolling(avatarId);
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
            updateAvatar(hookId, avatarId, {
              lipsyncStatus: "done",
              lipsyncVideoUrl: item.output_url,
            });
            stopPolling(avatarId);
          } else if (item.status === "failed") {
            updateAvatar(hookId, avatarId, {
              lipsyncStatus: "failed",
              lipsyncError: item.error || "Kling failed",
            });
            stopPolling(avatarId);
          }
        } catch {
          /* blip */
        }
      };
      const i = setInterval(poll, 5000);
      pollers.current.set(avatarId, i);
      void poll();
    },
    [stopPolling, updateAvatar],
  );

  // Resume polling on hydrate for any 'processing' avatar.
  useEffect(() => {
    if (!brief) return;
    for (const h of brief.hooks) {
      for (const a of h.avatars) {
        if (a.lipsyncStatus === "processing" && a.lipsyncBatchId) {
          startPollingAvatar(h.id, a.id, a.lipsyncBatchId);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief?.id]);

  // ---------------------------------------------------------------------
  // Lipsync trigger
  // ---------------------------------------------------------------------
  const runLipsync = useCallback(
    async (hookId: string, avatar: AvatarSlot) => {
      if (!avatar.imageUrl || !avatar.voClipUrl) {
        alert("Il faut une image ET un clip vocal avant le lipsync.");
        return;
      }
      updateAvatar(hookId, avatar.id, {
        lipsyncStatus: "processing",
        lipsyncError: undefined,
      });
      try {
        let audioDurationSec = 10;
        try {
          const resp = await fetch(avatar.voClipUrl);
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
          /* fallback */
        }
        const r = await fetch("/api/lipsync/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageUrl: avatar.imageUrl,
            audioUrl: avatar.voClipUrl,
            prompt: avatar.lipsyncPrompt || DEFAULT_LIPSYNC_PROMPT,
            modelKey: "kling-avatars-2",
            qualityLabel: avatar.lipsyncQuality || "Pro",
            audioDurationSec,
          }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
        updateAvatar(hookId, avatar.id, {
          lipsyncBatchId: data.batch_id,
          lipsyncTaskId: data.task_id,
          lipsyncStatus: "processing",
        });
        startPollingAvatar(hookId, avatar.id, data.batch_id);
      } catch (e) {
        updateAvatar(hookId, avatar.id, {
          lipsyncStatus: "failed",
          lipsyncError: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [startPollingAvatar, updateAvatar],
  );

  // ---------------------------------------------------------------------
  // Wizard navigation — phases + sub-steps
  // ---------------------------------------------------------------------
  const phases = useMemo(() => (brief ? computePhases(brief) : []), [brief]);
  const flatSteps = useMemo(() => flattenSteps(phases), [phases]);
  const currentStep = useMemo(() => {
    if (!brief || flatSteps.length === 0) return null;
    const found = flatSteps.find((s) => s.id === brief.currentStepId);
    return found ?? flatSteps[0];
  }, [brief, flatSteps]);
  const currentIdx = currentStep ? flatSteps.indexOf(currentStep) : 0;

  // Find which phase the current step belongs to, and its index inside
  // that phase.
  const { currentPhase, currentSubIdx } = useMemo(() => {
    if (!currentStep || phases.length === 0) {
      return { currentPhase: phases[0] ?? null, currentSubIdx: 0 };
    }
    for (const p of phases) {
      const sub = p.steps.findIndex((s) => s.id === currentStep.id);
      if (sub >= 0) return { currentPhase: p, currentSubIdx: sub };
    }
    return { currentPhase: phases[0], currentSubIdx: 0 };
  }, [currentStep, phases]);

  const goToStep = useCallback(
    (id: string) => {
      update({ currentStepId: id });
    },
    [update],
  );

  const goToPhase = useCallback(
    (phaseId: string) => {
      const p = phases.find((x) => x.id === phaseId);
      if (p && p.steps[0]) goToStep(p.steps[0].id);
    },
    [phases, goToStep],
  );

  const goNext = useCallback(() => {
    const n = flatSteps[currentIdx + 1];
    if (n) goToStep(n.id);
  }, [currentIdx, flatSteps, goToStep]);

  const goBack = useCallback(() => {
    const p = flatSteps[currentIdx - 1];
    if (p) goToStep(p.id);
  }, [currentIdx, flatSteps, goToStep]);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  if (notFound) {
    return (
      <div className="bg-pf-elev border border-pf-border rounded-xl p-10 text-center">
        <div className="text-sm font-semibold mb-2">Brief introuvable</div>
        <Link href="/briefs" className="text-xs text-pf-accent">
          ← Retour à la liste
        </Link>
      </div>
    );
  }
  if (!brief || !currentStep) {
    return (
      <div className="flex items-center gap-2 text-xs text-pf-muted">
        <Loader2 size={14} className="animate-spin" />
        Chargement…
      </div>
    );
  }

  const currentHook = currentStep.hookId
    ? brief.hooks.find((h) => h.id === currentStep.hookId)
    : null;

  return (
    <div className="space-y-6 pb-32">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/briefs"
          className="text-xs text-pf-dim hover:text-pf-accent flex items-center gap-1"
        >
          <ArrowLeft size={12} />
          Tous les briefs
        </Link>
        <span className="text-[10px] uppercase tracking-[1.2px] text-pf-muted font-mono">
          {brief.template === "avatar" ? "B-Roll + Avatars" : "Simple"} ·{" "}
          {brief.hooks.length} hooks · {new Date(brief.updatedAt).toLocaleString()}
        </span>
      </div>

      <div className="text-2xl font-bold">{brief.adsetName}</div>

      {/* Phase tabs — high-level navigation. The step rail is intentionally
          NOT shown globally; only this phase's sub-step indicator is
          displayed below. */}
      <div className="grid grid-cols-4 gap-2">
        {phases.map((p, i) => {
          const active = currentPhase?.id === p.id;
          const phaseDone = p.steps.every((s) => isStepDone(brief, s));
          const tag = i === phases.length - 1 ? "Final" : `Phase ${i + 1}`;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => goToPhase(p.id)}
              className={`text-left rounded-lg border px-3 py-3 transition-colors ${
                active
                  ? "bg-pf-accent text-pf-accent-fg border-pf-accent"
                  : phaseDone
                    ? "bg-pf-elev border-pf-accent/40 text-pf-text hover:border-pf-accent"
                    : "bg-pf-elev border-pf-border text-pf-muted hover:border-pf-dim"
              }`}
            >
              <div className="text-[10px] uppercase tracking-[1.2px] font-semibold opacity-80">
                {tag}
              </div>
              <div className="text-sm font-bold mt-0.5">
                {phaseDone && !active ? "✓ " : ""}
                {p.label}
              </div>
            </button>
          );
        })}
      </div>

      {/* Sub-step indicator inside current phase. */}
      {currentPhase ? (
        <div className="flex items-center justify-between gap-3">
          <div className="text-[11px] text-pf-muted font-mono">
            Étape {currentSubIdx + 1} / {currentPhase.steps.length} dans{" "}
            <span className="text-pf-text font-semibold">{currentPhase.label}</span> ·{" "}
            {currentStep.shortLabel}
          </div>
          <div className="h-1 bg-pf-soft rounded-full overflow-hidden flex-1 max-w-[200px]">
            <div
              className="h-full bg-pf-accent transition-all"
              style={{
                width: `${((currentSubIdx + 1) / currentPhase.steps.length) * 100}%`,
              }}
            />
          </div>
        </div>
      ) : null}

      {/* Step content */}
      <div className="bg-pf-elev border border-pf-border rounded-xl p-5">
        {currentStep.kind === "setup" ? (
          <SetupStep brief={brief} onUpdate={update} />
        ) : null}
        {currentStep.kind === "hook-script" && currentHook ? (
          <HookScriptStep
            brief={brief}
            hook={currentHook}
            onUpdate={update}
            onUpdateHook={(p) => updateHook(currentHook.id, p)}
          />
        ) : null}
        {currentStep.kind === "hook-vo" && currentHook ? (
          <HookVoStep
            brief={brief}
            hook={currentHook}
            onUpdateHook={(p) => updateHook(currentHook.id, p)}
            router={router}
          />
        ) : null}
        {currentStep.kind === "hook-avatars" && currentHook ? (
          <HookAvatarsStep
            brief={brief}
            hook={currentHook}
            onUpdateAvatar={(avId, p) => updateAvatar(currentHook.id, avId, p)}
            onRunLipsync={(av) => runLipsync(currentHook.id, av)}
            router={router}
          />
        ) : null}
        {currentStep.kind === "hook-summary" && currentHook ? (
          <HookSummaryStep
            brief={brief}
            hook={currentHook}
            onJump={goToStep}
            onUpdateHook={(p) => updateHook(currentHook.id, p)}
          />
        ) : null}
        {currentStep.kind === "final" ? (
          <FinalSummaryStep brief={brief} onJump={goToStep} onUpdate={update} />
        ) : null}
      </div>

      {/* Bottom nav */}
      <div className="fixed left-0 right-0 bottom-0 z-30 bg-pf-bg/95 backdrop-blur-md border-t border-pf-border px-5 py-3">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between">
          <button
            type="button"
            onClick={goBack}
            disabled={currentIdx === 0}
            className="flex items-center gap-1.5 text-sm bg-pf-soft border border-pf-border text-pf-text rounded-md px-4 py-2 hover:border-pf-accent disabled:opacity-40"
          >
            <ArrowLeft size={14} />
            Précédent
          </button>
          <div className="text-[11px] text-pf-muted font-mono">
            {currentIdx + 1} / {flatSteps.length} · {currentStep.shortLabel}
          </div>
          <button
            type="button"
            onClick={goNext}
            disabled={currentIdx === flatSteps.length - 1}
            className="flex items-center gap-1.5 text-sm font-semibold bg-pf-accent text-pf-accent-fg rounded-md px-5 py-2 hover:opacity-90 disabled:opacity-40"
          >
            Suivant
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step "doneness" — used to decorate the rail with checkmarks
// ---------------------------------------------------------------------------
function isStepDone(brief: Brief, step: Step): boolean {
  switch (step.kind) {
    case "setup":
      return brief.template === "simple" || brief.avatarCount >= 1;
    case "hook-script": {
      const h = brief.hooks.find((x) => x.id === step.hookId);
      return !!h && h.hookScript.trim().length > 0;
    }
    case "hook-vo": {
      const h = brief.hooks.find((x) => x.id === step.hookId);
      return !!h?.cutVoUrl;
    }
    case "hook-avatars": {
      const h = brief.hooks.find((x) => x.id === step.hookId);
      return !!h && h.avatars.length > 0 && h.avatars.every((a) => !!a.imageUrl && !!a.voClipUrl);
    }
    case "hook-summary":
      return false;
    case "final":
      return false;
  }
  return false;
}

// ===========================================================================
// STEP COMPONENTS
// ===========================================================================

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[11px] text-pf-muted leading-snug">{hint}</p> : null}
    </div>
  );
}

function StepTitle({ subtitle, title }: { subtitle?: string; title: string }) {
  return (
    <div className="mb-5">
      {subtitle ? (
        <div className="text-[10px] uppercase tracking-[1.2px] text-pf-accent font-semibold mb-1">
          {subtitle}
        </div>
      ) : null}
      <h2 className="text-xl font-bold">{title}</h2>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Setup
// ---------------------------------------------------------------------------
function SetupStep({
  brief,
  onUpdate,
}: {
  brief: Brief;
  onUpdate: (p: Partial<Brief>) => void;
}) {
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <StepTitle subtitle="Étape 1" title="Setup de l'adset" />
      <p className="text-sm text-pf-dim">
        Quelques infos avant de plonger dans le script et les variations.
      </p>

      {brief.template === "avatar" ? (
        <Field
          label="Nombre d'avatars par hook"
          hint="Chaque hook (1, 2, 3) génèrera ce nombre d'avatars à lip-syncer."
        >
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() =>
                onUpdate(syncAvatarCount(brief, Math.max(1, brief.avatarCount - 1)))
              }
              className="w-9 h-9 rounded-md bg-pf-soft border border-pf-border hover:border-pf-accent flex items-center justify-center"
            >
              <Minus size={14} />
            </button>
            <span className="font-mono text-2xl font-semibold w-12 text-center">
              {brief.avatarCount}
            </span>
            <button
              type="button"
              onClick={() =>
                onUpdate(syncAvatarCount(brief, Math.min(5, brief.avatarCount + 1)))
              }
              className="w-9 h-9 rounded-md bg-pf-soft border border-pf-border hover:border-pf-accent flex items-center justify-center"
            >
              <Plus size={14} />
            </button>
            <span className="text-[11px] text-pf-muted">max 5</span>
          </div>
        </Field>
      ) : null}

      <Field
        label="Référence créative (optionnel)"
        hint="Lien d'une ad concurrente ou d'une marque référence — pour que tu te souviennes du style ciblé."
      >
        <input
          type="url"
          value={brief.creativeRef ?? ""}
          onChange={(e) => onUpdate({ creativeRef: e.target.value })}
          placeholder="https://…"
          className="w-full bg-pf-soft border border-pf-border rounded-md px-3 py-2 text-sm placeholder:text-pf-muted focus:outline-none focus:border-pf-accent"
        />
      </Field>

      <Field label="Nom de l'adset" hint="Auto-suggéré à partir du script (étape suivante).">
        <input
          type="text"
          value={brief.adsetName}
          onChange={(e) => onUpdate({ adsetName: e.target.value })}
          className="w-full bg-pf-soft border border-pf-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-pf-accent"
        />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase X · Step — Script
//
// For V1 (hook.index === 1): full ad script + adset name auto-suggestion.
// For H2/H3 (index 2, 3): the alt hook script only — usually a short
// alternative opener that's spliced before / after the V1 video.
// ---------------------------------------------------------------------------
function HookScriptStep({
  brief,
  hook,
  onUpdate,
  onUpdateHook,
}: {
  brief: Brief;
  hook: HookBrief;
  onUpdate: (p: Partial<Brief>) => void;
  onUpdateHook: (p: Partial<HookBrief>) => void;
}) {
  const isV1 = hook.index === 1;

  // V1 only: auto-suggest the adset name as long as the user hasn't taken
  // it over (i.e. it still starts with "Ad Test #N — …").
  useEffect(() => {
    if (!isV1) return;
    if (!hook.hookScript.trim()) return;
    if (brief.adsetName && !brief.adsetName.startsWith("Ad Test #")) return;
    onUpdate({ adsetName: suggestAdsetName(hook.hookScript, 0) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hook.hookScript, isV1]);

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      {isV1 ? (
        <>
          <StepTitle subtitle="Version 1" title="Script de la vidéo complète" />
          <p className="text-sm text-pf-dim">
            Le script complet de la vidéo de base. Hook 2 et Hook 3 seront des
            alternatives de la phrase d&apos;ouverture (ou de fermeture) seulement.
          </p>
        </>
      ) : (
        <>
          <StepTitle subtitle={`Hook ${hook.index}`} title="Variation du hook" />
          <p className="text-sm text-pf-dim">
            Juste la partie qui change — l&apos;ouverture alternative. Pas besoin
            de ré-écrire toute la vidéo, ce hook viendra remplacer celui de la
            Version 1.
          </p>
        </>
      )}

      <Field label={isV1 ? "Script complet" : `Hook ${hook.index}`}>
        <textarea
          value={hook.hookScript}
          onChange={(e) => onUpdateHook({ hookScript: e.target.value })}
          rows={isV1 ? 14 : 6}
          placeholder={
            isV1
              ? "Colle le script complet…"
              : "Ex: « Après 40, vous avez perdu 25% de votre collagène sous les yeux. »"
          }
          className="w-full bg-pf-soft border border-pf-border rounded-md px-3 py-3 text-sm placeholder:text-pf-muted resize-y focus:outline-none focus:border-pf-accent"
        />
      </Field>

      {isV1 && brief.adsetName ? (
        <div className="bg-pf-bg border border-pf-border rounded-md p-3">
          <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted font-semibold mb-1">
            Nom de l&apos;adset
          </div>
          <div className="font-mono text-sm">{brief.adsetName}</div>
          <p className="text-[11px] text-pf-muted mt-1">
            Auto-suggéré. Tu peux le changer à l&apos;étape Setup (ne sera plus
            écrasé une fois personnalisé).
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hook · Step B — Voice off (state machine)
// ---------------------------------------------------------------------------
function HookVoStep({
  brief,
  hook,
  onUpdateHook,
  router,
}: {
  brief: Brief;
  hook: HookBrief;
  onUpdateHook: (p: Partial<HookBrief>) => void;
  router: ReturnType<typeof useRouter>;
}) {
  const [copied, setCopied] = useState(false);

  const handoffGenerate = useCallback(() => {
    setAttachTarget({ kind: "mainVo", briefId: brief.id, hookId: hook.id });
    if (hook.hookScript.trim()) {
      try {
        window.sessionStorage.setItem(
          "pf:voHandoff",
          JSON.stringify({ text: hook.hookScript, ts: Date.now() }),
        );
      } catch {
        /* */
      }
    }
    router.push("/voiceover");
  }, [brief.id, hook.id, hook.hookScript, router]);

  const handoffCut = useCallback(() => {
    if (!hook.mainVoUrl) return;
    setAttachTarget({ kind: "cutVo", briefId: brief.id, hookId: hook.id });
    try {
      window.sessionStorage.setItem(
        "pf:cutSilenceHandoff",
        JSON.stringify({
          audioUrl: hook.mainVoUrl,
          fileName: `${brief.adsetName.replace(/[^a-z0-9]+/gi, "_")}_h${hook.index}_main.mp3`,
          ts: Date.now(),
        }),
      );
    } catch {
      /* */
    }
    router.push("/cut-silence");
  }, [brief.id, brief.adsetName, hook.id, hook.index, hook.mainVoUrl, router]);

  const copyUrl = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* */
    }
  }, []);

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <StepTitle subtitle={phaseLabel(hook.index)} title="Voix off" />
      <p className="text-sm text-pf-dim">
        Génère la voix off, coupe les blancs si besoin, et finalise. Le script
        est pré-rempli sur Voiceover.
      </p>

      {hook.cutVoUrl ? (
        <div className="bg-pf-bg border border-pf-border rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-pf-accent">
              ✓ Voix off finalisée
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => copyUrl(hook.cutVoUrl!)}
                className="flex items-center gap-1 text-xs text-pf-dim hover:text-pf-accent border border-pf-border rounded-md px-2 py-1"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                URL
              </button>
              <a
                href={hook.cutVoUrl}
                download
                className="flex items-center gap-1 text-xs text-pf-dim hover:text-pf-accent border border-pf-border rounded-md px-2 py-1"
              >
                <Download size={12} />
              </a>
              {hook.mainVoUrl ? (
                <button
                  type="button"
                  onClick={handoffCut}
                  className="text-[11px] text-pf-dim hover:text-pf-accent border border-pf-border rounded-md px-2 py-1"
                >
                  Re-cut
                </button>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  onUpdateHook({
                    cutVoUrl: undefined,
                    cutVoDurationSec: undefined,
                    mainVoUrl: undefined,
                    mainVoVoiceName: undefined,
                  })
                }
                className="text-pf-muted hover:text-pf-danger px-1.5 py-1"
              >
                <X size={12} />
              </button>
            </div>
          </div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls src={hook.cutVoUrl} className="w-full" />
          <div className="text-[11px] text-pf-muted mt-1.5 flex items-center gap-3">
            {hook.cutVoDurationSec ? (
              <span>Durée : {hook.cutVoDurationSec.toFixed(1)}s</span>
            ) : null}
            {hook.mainVoVoiceName ? <span>Voix : {hook.mainVoVoiceName}</span> : null}
          </div>
        </div>
      ) : hook.mainVoUrl ? (
        <div className="bg-pf-bg border border-pf-warn/40 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-pf-warn">
              ⚠ VO brute — à couper
            </span>
            <button
              type="button"
              onClick={() => onUpdateHook({ mainVoUrl: undefined, mainVoVoiceName: undefined })}
              className="text-pf-muted hover:text-pf-danger px-1.5 py-1"
            >
              <X size={12} />
            </button>
          </div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls src={hook.mainVoUrl} className="w-full" />
          {hook.mainVoVoiceName ? (
            <div className="text-[11px] text-pf-muted mt-1.5">
              Voix : {hook.mainVoVoiceName}
            </div>
          ) : null}
          <button
            type="button"
            onClick={handoffCut}
            className="mt-3 w-full bg-pf-accent text-pf-accent-fg font-semibold rounded-md px-4 py-2 text-sm flex items-center justify-center gap-2"
          >
            <Scissors size={14} />
            Cut blanks pour finaliser
          </button>
        </div>
      ) : (
        <div className="bg-pf-bg border border-pf-border rounded-lg p-4">
          <button
            type="button"
            onClick={handoffGenerate}
            disabled={!hook.hookScript.trim()}
            className="bg-pf-accent text-pf-accent-fg font-semibold rounded-md px-4 py-2 text-sm flex items-center gap-2 disabled:opacity-40"
          >
            <Mic size={14} />
            Générer dans Voiceover
          </button>
          <p className="text-[11px] text-pf-muted mt-2">
            {hook.hookScript.trim()
              ? "Le script du hook est pré-rempli sur Voiceover. Génère, coupe, attache."
              : "Remplis d'abord le script du hook (étape précédente)."}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hook · Step C — Avatars (clip + image + lipsync per avatar)
// ---------------------------------------------------------------------------
function HookAvatarsStep({
  brief,
  hook,
  onUpdateAvatar,
  onRunLipsync,
  router,
}: {
  brief: Brief;
  hook: HookBrief;
  onUpdateAvatar: (avId: string, p: Partial<AvatarSlot>) => void;
  onRunLipsync: (av: AvatarSlot) => void;
  router: ReturnType<typeof useRouter>;
}) {
  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <StepTitle subtitle={phaseLabel(hook.index)} title="Avatars" />
      <p className="text-sm text-pf-dim">
        Pour chaque avatar : assigne un clip vocal (extrait de la voix off) et
        une image, puis génère le lipsync.
      </p>

      {!hook.cutVoUrl ? (
        <div className="bg-pf-bg border border-pf-warn/40 rounded-md px-4 py-3 text-xs text-pf-warn">
          ⚠ Finalise d&apos;abord la voix off de ce hook (étape B) pour pouvoir
          assigner les clips aux avatars.
        </div>
      ) : null}

      <div className="space-y-3">
        {hook.avatars.map((av, i) => (
          <AvatarCard
            key={av.id}
            avatar={av}
            index={i + 1}
            briefId={brief.id}
            hookId={hook.id}
            hookScript={hook.hookScript}
            hookCutVoUrl={hook.cutVoUrl}
            hookLabel={phaseLabel(hook.index)}
            onUpdate={(p) => onUpdateAvatar(av.id, p)}
            onRunLipsync={() => onRunLipsync(av)}
            router={router}
          />
        ))}
      </div>
    </div>
  );
}

function AvatarCard({
  avatar,
  index,
  briefId,
  hookId,
  hookScript,
  hookCutVoUrl,
  hookLabel,
  onUpdate,
  onRunLipsync,
  router,
}: {
  avatar: AvatarSlot;
  index: number;
  briefId: string;
  hookId: string;
  hookScript: string;
  hookCutVoUrl?: string;
  hookLabel: string;
  onUpdate: (p: Partial<AvatarSlot>) => void;
  onRunLipsync: () => void;
  router: ReturnType<typeof useRouter>;
}) {
  const handoffClip = useCallback(() => {
    setAttachTarget({ kind: "avatarClip", briefId, hookId, avatarId: avatar.id });
    if (hookScript.trim()) {
      try {
        window.sessionStorage.setItem(
          "pf:voHandoff",
          JSON.stringify({ text: hookScript, ts: Date.now() }),
        );
      } catch {
        /* */
      }
    }
    router.push("/voiceover");
  }, [avatar.id, briefId, hookId, hookScript, router]);

  const useFullHookVo = useCallback(() => {
    if (!hookCutVoUrl) return;
    // Copy the finalised hook VO straight into this avatar's clip slot —
    // used when the avatar speaks for the whole video (no slicing needed).
    onUpdate({ voClipUrl: hookCutVoUrl, voClipText: hookScript });
  }, [hookCutVoUrl, hookScript, onUpdate]);

  const handoffImage = useCallback(() => {
    setAttachTarget({ kind: "avatarImage", briefId, hookId, avatarId: avatar.id });
    router.push("/");
  }, [avatar.id, briefId, hookId, router]);

  const lipsyncReady = !!avatar.voClipUrl && !!avatar.imageUrl;
  const isWorking = avatar.lipsyncStatus === "processing";

  return (
    <div className="bg-pf-bg border border-pf-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-pf-soft border border-pf-border flex items-center justify-center text-pf-accent text-xs font-bold">
            {index}
          </div>
          <input
            type="text"
            value={avatar.label}
            onChange={(e) => onUpdate({ label: e.target.value })}
            className="bg-transparent border-0 outline-none font-semibold text-sm focus:bg-pf-elev rounded-md px-2 -mx-2 py-0.5"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted font-semibold mb-1.5">
            Clip vocal
          </div>
          {avatar.voClipUrl ? (
            <div className="bg-pf-soft border border-pf-border rounded-md p-2">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio controls src={avatar.voClipUrl} className="w-full h-8" />
              <button
                type="button"
                onClick={() => onUpdate({ voClipUrl: undefined, voClipText: undefined })}
                className="text-[10px] text-pf-muted hover:text-pf-danger mt-1"
              >
                Reset
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {hookCutVoUrl ? (
                <button
                  type="button"
                  onClick={useFullHookVo}
                  className="w-full bg-pf-accent text-pf-accent-fg font-semibold rounded-md px-3 py-2.5 text-xs flex items-center justify-center gap-2 hover:opacity-90"
                  title="L'avatar parlera pendant toute la vidéo"
                >
                  <Wand2 size={12} />
                  Reprendre toute la voix off de {hookLabel}
                </button>
              ) : null}
              <button
                type="button"
                onClick={handoffClip}
                className="w-full bg-pf-soft border border-dashed border-pf-border hover:border-pf-accent rounded-md px-3 py-2.5 text-xs text-pf-dim hover:text-pf-text flex items-center justify-center gap-2"
              >
                <Mic size={12} />
                {hookCutVoUrl ? "ou attacher un extrait depuis Voiceover" : "Attacher depuis Voiceover"}
              </button>
              {!hookCutVoUrl ? (
                <p className="text-[10px] text-pf-muted leading-snug">
                  Finalise d&apos;abord la voix off ({hookLabel}) pour pouvoir
                  la réutiliser en un clic.
                </p>
              ) : null}
            </div>
          )}
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted font-semibold mb-1.5">
            Image
          </div>
          {avatar.imageUrl ? (
            <div className="bg-pf-soft border border-pf-border rounded-md p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={avatar.imageUrl}
                alt=""
                className="w-full h-28 object-cover rounded-sm"
              />
              <button
                type="button"
                onClick={() => onUpdate({ imageUrl: undefined, imagePrompt: undefined })}
                className="text-[10px] text-pf-muted hover:text-pf-danger mt-1"
              >
                Reset
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handoffImage}
              className="w-full bg-pf-soft border border-dashed border-pf-border hover:border-pf-accent rounded-md px-3 py-3 text-xs text-pf-dim hover:text-pf-text flex items-center justify-center gap-2"
            >
              <ImagePlus size={12} />
              Attacher depuis Image
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_140px] gap-3 mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted font-semibold mb-1.5">
            Lipsync prompt
          </div>
          <textarea
            value={avatar.lipsyncPrompt || ""}
            onChange={(e) => onUpdate({ lipsyncPrompt: e.target.value })}
            rows={2}
            className="w-full bg-pf-soft border border-pf-border rounded-md px-2.5 py-2 text-xs resize-y focus:outline-none focus:border-pf-accent"
          />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted font-semibold mb-1.5">
            Qualité
          </div>
          <select
            value={avatar.lipsyncQuality || "Pro"}
            onChange={(e) =>
              onUpdate({ lipsyncQuality: e.target.value as "Pro" | "Standard" })
            }
            className="w-full bg-pf-soft border border-pf-border rounded-md px-2.5 py-2 text-xs focus:outline-none focus:border-pf-accent"
          >
            <option value="Pro">Pro</option>
            <option value="Standard">Standard</option>
          </select>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onRunLipsync}
          disabled={!lipsyncReady || isWorking}
          className="bg-pf-accent text-pf-accent-fg font-semibold rounded-md px-4 py-2 text-sm flex items-center gap-2 disabled:opacity-40"
        >
          {isWorking ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
          {isWorking ? "Génération…" : "Generate lipsync"}
        </button>
        {!lipsyncReady ? (
          <span className="text-[11px] text-pf-muted">Clip + image requis.</span>
        ) : null}
        {avatar.lipsyncStatus === "failed" && avatar.lipsyncError ? (
          <span className="text-[11px] text-pf-danger truncate">⚠ {avatar.lipsyncError}</span>
        ) : null}
      </div>

      {avatar.lipsyncVideoUrl && avatar.lipsyncStatus === "done" ? (
        <div className="mt-3 bg-pf-soft border border-pf-border rounded-md p-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-pf-accent">
              ✓ Lipsync prêt
            </span>
            <a
              href={avatar.lipsyncVideoUrl}
              download
              className="text-[10px] text-pf-dim hover:text-pf-accent flex items-center gap-1"
            >
              <Download size={10} />
              MP4
            </a>
          </div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            controls
            src={avatar.lipsyncVideoUrl}
            className="w-full max-h-72 rounded-sm bg-black"
          />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hook · Step D — Summary
// ---------------------------------------------------------------------------
function HookSummaryStep({
  brief,
  hook,
  onJump,
  onUpdateHook,
}: {
  brief: Brief;
  hook: HookBrief;
  onJump: (stepId: string) => void;
  onUpdateHook: (p: Partial<HookBrief>) => void;
}) {
  const doneAvatars = hook.avatars.filter((a) => a.lipsyncStatus === "done" && a.lipsyncVideoUrl);

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <StepTitle
        subtitle={phaseLabel(hook.index)}
        title={`Récap ${phaseLabel(hook.index)}`}
      />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Pill ok={hook.hookScript.trim().length > 0} label="Script" onClick={() => onJump(`${hook.id}-script`)} />
        <Pill ok={!!hook.cutVoUrl} label="Voix off finalisée" onClick={() => onJump(`${hook.id}-vo`)} />
        {brief.template === "avatar" ? (
          <>
            <Pill
              ok={hook.avatars.every((a) => !!a.imageUrl && !!a.voClipUrl)}
              label={`Avatars prêts (${hook.avatars.filter((a) => !!a.imageUrl && !!a.voClipUrl).length}/${hook.avatars.length})`}
              onClick={() => onJump(`${hook.id}-avatars`)}
            />
            <Pill
              ok={doneAvatars.length === hook.avatars.length && hook.avatars.length > 0}
              label={`Lipsyncs (${doneAvatars.length}/${hook.avatars.length})`}
              onClick={() => onJump(`${hook.id}-avatars`)}
            />
          </>
        ) : null}
      </div>

      {hook.cutVoUrl ? (
        <div>
          <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted font-semibold mb-1.5">
            Voix off finalisée
          </div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls src={hook.cutVoUrl} className="w-full" />
        </div>
      ) : null}

      {brief.template === "avatar" && doneAvatars.length > 0 ? (
        <div>
          <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted font-semibold mb-1.5">
            Lipsyncs prêts
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {doneAvatars.map((a) => (
              <div key={a.id} className="bg-pf-bg border border-pf-border rounded-md p-2">
                <div className="text-[11px] font-semibold mb-1.5">{a.label}</div>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video controls src={a.lipsyncVideoUrl} className="w-full rounded-sm bg-black" />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Per-video monteur notes. Each hook gets its own — instructions
          often differ between V1 / H2 / H3 (b-rolls, captions, music). */}
      <Field
        label={`Notes monteur — ${phaseLabel(hook.index)}`}
        hint="Spécifique à cette vidéo. Durée cible, b-rolls à insérer, sous-titres, hook préféré…"
      >
        <textarea
          value={hook.notes ?? ""}
          onChange={(e) => onUpdateHook({ notes: e.target.value })}
          rows={5}
          placeholder={
            hook.index === 1
              ? "Ex: 9:16, ~30s, sous-titres FR brûlés, music UGC chill, hook visible à 0s"
              : "Ex: même base que V1 mais hook 0-3s + zoom punch, garder le CTA final"
          }
          className="w-full bg-pf-soft border border-pf-border rounded-md px-3 py-2.5 text-sm placeholder:text-pf-muted resize-y focus:outline-none focus:border-pf-accent"
        />
      </Field>

      {/* IA / workflow directives (e.g. "@ Le hook ne remplace pas
          l'original, il vient devant"). Distinct from monteur notes so
          the user can tell operational rules from filming directions
          at a glance. */}
      <Field
        label={`Instructions IA / workflow — ${phaseLabel(hook.index)}`}
        hint="Directives importées des lignes `@` du Google Doc, ou ajoutées à la main. Synchronisées dans une section dédiée sur Notion."
      >
        <textarea
          value={hook.aiInstructions ?? ""}
          onChange={(e) => onUpdateHook({ aiInstructions: e.target.value })}
          rows={3}
          placeholder="Ex: Le hook ne remplace pas l'original, il vient devant. Garder le CTA final intact."
          className="w-full bg-pf-warn/5 border border-pf-warn/40 rounded-md px-3 py-2.5 text-sm placeholder:text-pf-muted resize-y focus:outline-none focus:border-pf-warn"
        />
      </Field>
    </div>
  );
}

function Pill({
  ok,
  label,
  onClick,
}: {
  ok: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-md px-2.5 py-2 border ${
        ok
          ? "bg-pf-bg border-pf-accent/40 text-pf-text"
          : "bg-pf-bg border-pf-border text-pf-muted hover:border-pf-accent/40"
      }`}
    >
      <div className="text-[10px] uppercase tracking-[1.2px] font-semibold">
        {ok ? "✓" : "·"} {label}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Final — Whole brief summary for the monteur
// ---------------------------------------------------------------------------
function FinalSummaryStep({
  brief,
  onJump,
  onUpdate,
}: {
  brief: Brief;
  onJump: (stepId: string) => void;
  onUpdate: (p: Partial<Brief>) => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const handleSyncToNotion = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    try {
      const r = await fetch("/api/notion/sync-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief }),
      });
      const raw = await r.text();
      let data: {
        pages?: Array<{ hookId: string; pageId: string; url: string; error?: string }>;
        partial?: boolean;
        error?: string;
      };
      try {
        data = JSON.parse(raw) as typeof data;
      } catch {
        throw new Error(`Réponse non-JSON (HTTP ${r.status}) : ${raw.slice(0, 160)}`);
      }
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      if (!data.pages || data.pages.length === 0) {
        throw new Error("Réponse Notion sans pages");
      }

      // Apply per-hook updates. Each successful entry attaches its
      // notionPageId/url to the corresponding hook.
      const successes = data.pages.filter((p) => !p.error && p.pageId);
      const failures = data.pages.filter((p) => p.error);

      onUpdate({
        notionSyncedAt: Date.now(),
        hooks: brief.hooks.map((h) => {
          const match = successes.find((p) => p.hookId === h.id);
          return match ? { ...h, notionPageId: match.pageId, notionUrl: match.url } : h;
        }),
      });

      // Open the first page in a new tab so the user can validate.
      if (successes[0]?.url) {
        window.open(successes[0].url, "_blank", "noopener");
      }
      if (failures.length > 0) {
        setSyncError(
          `${successes.length}/${data.pages.length} pages créées. Échec: ${failures[0].error}`,
        );
      }
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }, [brief, onUpdate, syncing]);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <StepTitle subtitle="Final" title="Récap brief pour le monteur" />

      {/* Notion sync — 1 page per hook variation */}
      <div className="bg-pf-bg border border-pf-border rounded-xl p-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted font-semibold mb-1">
              Notion
            </div>
            <div className="text-sm font-semibold">
              {brief.hooks.some((h) => h.notionUrl)
                ? "Sync précédent — 1 page par variante"
                : "Push ce brief — 1 page Notion par variante"}
            </div>
            {brief.notionSyncedAt ? (
              <div className="text-[11px] text-pf-muted mt-0.5">
                Dernier sync : {new Date(brief.notionSyncedAt).toLocaleString()}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleSyncToNotion}
            disabled={syncing}
            className="bg-pf-accent text-pf-accent-fg font-semibold rounded-md px-4 py-1.5 text-xs flex items-center gap-1.5 disabled:opacity-40 shrink-0"
          >
            {syncing ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
            {syncing
              ? "Push en cours…"
              : brief.hooks.some((h) => h.notionUrl)
                ? "Re-sync les 3 pages"
                : "Sync to Notion"}
          </button>
        </div>

        {/* Per-hook page links */}
        {brief.hooks.some((h) => h.notionUrl) ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
            {brief.hooks.map((h) => (
              <div
                key={h.id}
                className="bg-pf-elev border border-pf-border rounded-md px-3 py-2"
              >
                <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted font-semibold">
                  {phaseLabel(h.index)}
                </div>
                {h.notionUrl ? (
                  <a
                    href={h.notionUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-pf-accent hover:underline flex items-center gap-1 mt-0.5 truncate"
                  >
                    <ExternalLink size={11} />
                    Ouvrir la page
                  </a>
                ) : (
                  <div className="text-[11px] text-pf-muted mt-0.5">
                    Pas encore sync
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : null}

        {syncError ? (
          <div className="bg-pf-elev border border-pf-danger/40 rounded-md px-3 py-2 text-xs text-pf-danger">
            ⚠ {syncError}
          </div>
        ) : null}
        <p className="text-[11px] text-pf-muted leading-snug">
          Crée 1 page par hook (Version 1, Hook 2, Hook 3) dans ta page Notion
          parent, en suivant la structure exacte de ton template Ad Creative
          (Performance Bonus, Reference, Script, Filming notes, AI Avatar,
          Voice over, Content access, Background music). Les fichiers passent
          d&apos;abord par Drive si le service account est configuré.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Pill
          ok={brief.template === "simple" || brief.avatarCount >= 1}
          label="Setup"
          onClick={() => onJump("setup")}
        />
        <Pill
          ok={!!brief.hooks[0]?.hookScript.trim()}
          label="Script V1"
          onClick={() => onJump(brief.hooks[0].id + "-script")}
        />
        <Pill
          ok={brief.hooks.every((h) => !!h.cutVoUrl)}
          label="3 voix off finalisées"
          onClick={() => onJump(brief.hooks[0].id + "-vo")}
        />
      </div>

      {brief.creativeRef ? (
        <div className="bg-pf-bg border border-pf-border rounded-md p-3">
          <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted font-semibold mb-1">
            Référence créative
          </div>
          <a
            href={brief.creativeRef}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-pf-accent flex items-center gap-1.5 break-all"
          >
            <ExternalLink size={12} /> {brief.creativeRef}
          </a>
        </div>
      ) : null}

      <div className="space-y-4">
        {brief.hooks.map((h) => (
          <div key={h.id} className="bg-pf-bg border border-pf-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold">{phaseLabel(h.index)}</h3>
              <button
                type="button"
                onClick={() => onJump(`${h.id}-summary`)}
                className="text-[11px] text-pf-dim hover:text-pf-accent"
              >
                Ouvrir →
              </button>
            </div>
            {h.hookScript ? (
              <p className="text-[12px] text-pf-dim italic line-clamp-3 mb-2">
                « {h.hookScript.slice(0, 220)}
                {h.hookScript.length > 220 ? "…" : ""} »
              </p>
            ) : (
              <p className="text-[11px] text-pf-muted italic mb-2">Pas encore de script.</p>
            )}
            {h.cutVoUrl ? (
              /* eslint-disable-next-line jsx-a11y/media-has-caption */
              <audio controls src={h.cutVoUrl} className="w-full mb-2" />
            ) : null}
            {brief.template === "avatar" && h.avatars.some((a) => a.lipsyncVideoUrl) ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                {h.avatars
                  .filter((a) => a.lipsyncVideoUrl)
                  .map((a) => (
                    <div key={a.id} className="bg-pf-elev rounded-md p-2">
                      <div className="text-[10px] font-semibold mb-1">{a.label}</div>
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <video
                        controls
                        src={a.lipsyncVideoUrl}
                        className="w-full rounded-sm bg-black"
                      />
                    </div>
                  ))}
              </div>
            ) : null}
            {h.aiInstructions?.trim() ? (
              <div className="bg-pf-warn/5 border border-pf-warn/40 rounded-md p-3 mt-2">
                <div className="text-[10px] uppercase tracking-[1.2px] text-pf-warn font-semibold mb-1">
                  Instructions IA / workflow
                </div>
                <p className="text-[12px] text-pf-text whitespace-pre-wrap leading-relaxed">
                  {h.aiInstructions}
                </p>
              </div>
            ) : null}
            {h.notes?.trim() ? (
              <div className="bg-pf-elev border border-pf-border rounded-md p-3 mt-2">
                <div className="text-[10px] uppercase tracking-[1.2px] text-pf-accent font-semibold mb-1">
                  Notes monteur
                </div>
                <p className="text-[12px] text-pf-text whitespace-pre-wrap leading-relaxed">
                  {h.notes}
                </p>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted font-semibold mb-1.5">
          Notes générales adset (optionnel)
        </div>
        <textarea
          value={brief.notes ?? ""}
          onChange={(e) => onUpdate({ notes: e.target.value })}
          rows={4}
          placeholder="Contexte qui s'applique aux 3 vidéos : marque, plateforme, format final, monteur destinataire…"
          className="w-full bg-pf-soft border border-pf-border rounded-md px-3 py-2.5 text-sm placeholder:text-pf-muted resize-y focus:outline-none focus:border-pf-accent"
        />
        <p className="text-[11px] text-pf-muted mt-1.5">
          Les notes spécifiques à chaque vidéo sont au Récap de chaque phase
          (V1, Hook 2, Hook 3) et déjà affichées plus haut.
        </p>
      </div>
    </div>
  );
}

