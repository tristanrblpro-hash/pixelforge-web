"use client";

// BatchResumeBanner — sticky strip rendered at the top of every page
// (right under TopNav) that shows up ONLY when:
//
//   1. The user has an active /briefs/batch session stashed in
//      sessionStorage (key "pf:batchWizard:v1", written by
//      BriefBatchWizard as state changes), AND
//   2. The current URL is NOT /briefs/batch itself.
//
// One click on the banner sends the user back to /briefs/batch where the
// wizard's sessionStorage hydration restores their step, rows, voState
// and lipsyncState — they pick up exactly where they left off.
//
// This is the answer to "I want to generate one image / one voice off
// then come back to my batch without losing context" — instead of
// having to remember "I was in step 5" and re-navigate manually.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, Sparkles, X } from "lucide-react";

const STATE_KEY = "pf:batchWizard:v1";
const DISMISSED_KEY = "pf:batchWizard:bannerDismissed";

type StepLabel = { id: number; label: string };
const STEP_LABELS: StepLabel[] = [
  { id: 1, label: "Briefs" },
  { id: 2, label: "Scripts" },
  { id: 3, label: "Voix off" },
  { id: 4, label: "Images" },
  { id: 5, label: "Lipsync" },
  { id: 6, label: "Sync" },
];

type PersistedBatchState = {
  step: number;
  rows?: Array<{ briefId?: string }>;
};

function readBatchState(): PersistedBatchState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedBatchState;
    if (typeof parsed?.step !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function isDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function BatchResumeBanner() {
  const pathname = usePathname();
  const [state, setState] = useState<PersistedBatchState | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Refresh whenever the URL changes (Next client-side nav) and on focus
  // (in case sessionStorage was updated in this tab while we were away).
  useEffect(() => {
    setState(readBatchState());
    setDismissed(isDismissed());
    const onFocus = () => {
      setState(readBatchState());
      setDismissed(isDismissed());
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [pathname]);

  // Hide on the batch page itself + when there's no active state + when
  // the user clicked the × to dismiss it for this session.
  const onBatchPage = pathname === "/briefs/batch";
  const hasBriefs =
    !!state && Array.isArray(state.rows) && state.rows.some((r) => r.briefId);
  if (onBatchPage || !state || !hasBriefs || dismissed) return null;

  const step = Math.max(1, Math.min(6, state.step));
  const stepLabel = STEP_LABELS.find((s) => s.id === step)?.label ?? "";
  const briefCount = state.rows!.filter((r) => r.briefId).length;

  const handleDismiss = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      window.sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* */
    }
    setDismissed(true);
  };

  return (
    <Link
      href="/briefs/batch"
      className="group sticky top-0 z-30 block bg-gradient-to-r from-pf-accent/20 via-pf-accent/10 to-pf-accent/20 border-b border-pf-accent/40 hover:from-pf-accent/30 hover:via-pf-accent/15 hover:to-pf-accent/30 transition-colors"
    >
      <div className="max-w-[1600px] mx-auto px-8 py-2.5 flex items-center gap-3">
        <div className="w-7 h-7 rounded-md bg-pf-accent/25 border border-pf-accent/50 text-pf-accent flex items-center justify-center shrink-0">
          <Sparkles size={14} />
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-2 text-sm flex-wrap">
          <span className="font-semibold text-pf-text">Batch hebdo en cours</span>
          <span className="text-pf-muted">·</span>
          <span className="text-pf-dim font-mono">
            étape {step}/6 · {stepLabel}
          </span>
          <span className="text-pf-muted">·</span>
          <span className="text-pf-dim font-mono">
            {briefCount} brief{briefCount > 1 ? "s" : ""}
          </span>
        </div>
        <span className="hidden sm:inline-flex items-center gap-1.5 text-sm font-semibold text-pf-accent shrink-0">
          Revenir au batch
          <ArrowRight
            size={14}
            className="group-hover:translate-x-0.5 transition-transform"
          />
        </span>
        <button
          type="button"
          onClick={handleDismiss}
          className="shrink-0 w-7 h-7 rounded-md text-pf-muted hover:text-pf-text hover:bg-pf-bg/50 flex items-center justify-center transition-colors"
          aria-label="Masquer ce bandeau pour cette session"
          title="Masquer (le batch reste en cours)"
        >
          <X size={14} />
        </button>
      </div>
    </Link>
  );
}
