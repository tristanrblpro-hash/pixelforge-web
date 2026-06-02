"use client";

// AttachToBriefButton — universal "📎 Attach to brief" affordance.
//
// Drop it next to any freshly-generated asset (a voice clip, an image, a
// video) and the user gets a 1-click flow to plug that asset into the
// slot of their choice inside any existing brief:
//
//   ┌─ Rattacher cet asset ─────────────────┐
//   │ Brief : ●━━━━━━ thumbnail + nom       │
//   │ Hook  : [V1] [Hook 2] [Hook 3]        │
//   │ Slot  : [Voix off] [Avatar 1] [Avt 2] │
//   │                                        │
//   │         [Annuler]    [Rattacher ✓]    │
//   └────────────────────────────────────────┘
//
// All persistence delegates to applyAttach() in lib/briefs.ts — this
// component is pure UI. Renders nothing if there are no briefs yet
// (instead it shows a "create a brief first" hint inline).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Check,
  FileText,
  ImageIcon,
  ImagePlus,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  Sparkles,
  Upload,
  Users,
  Video,
  X,
} from "lucide-react";

import {
  type AttachTarget,
  type Brief,
  type HookBrief,
  applyAttach,
  attachTargetLabel,
  clearAttach,
  getAttachValue,
  loadBrief,
  loadBriefs,
} from "@/lib/briefs";
import { uploadFileToStorage } from "@/lib/uploadFile";

// ---------------------------------------------------------------------------
// Fill-state helpers — used by the picker to show "filled X/Y" badges at
// every level (brief / hook / slot) so the user immediately sees what's
// already attached before they click and accidentally overwrite something.
// Counts are RELATIVE to the asset kind being attached.
// ---------------------------------------------------------------------------

type FillCount = { filled: number; total: number };

function hookFillForKind(hook: HookBrief, kind: AttachTarget["kind"]): FillCount {
  if (kind === "mainVo") {
    return { filled: hook.mainVoUrl ? 1 : 0, total: 1 };
  }
  if (kind === "cutVo") {
    return { filled: hook.cutVoUrl ? 1 : 0, total: 1 };
  }
  // Avatar-bound slots — one per avatar in the hook.
  const total = hook.avatars.length;
  let filled = 0;
  for (const a of hook.avatars) {
    if (kind === "avatarClip" && a.voClipUrl) filled++;
    else if (kind === "avatarImage" && a.imageUrl) filled++;
    else if (kind === "avatarLipsync" && a.lipsyncVideoUrl) filled++;
  }
  return { filled, total };
}

// Roll-up across the 3 hooks. Useful for the brief row preview, where
// the picker shows "Images 4/6" before the user even picks a hook.
function briefFillForKind(brief: Brief, kinds: AttachTarget["kind"][]): FillCount {
  let filled = 0;
  let total = 0;
  for (const h of brief.hooks) {
    for (const k of kinds) {
      const c = hookFillForKind(h, k);
      filled += c.filled;
      total += c.total;
    }
  }
  return { filled, total };
}

function briefHasAvatars(b: Brief): boolean {
  return b.hooks.some((h) => h.avatars.length > 0);
}

// ---------------------------------------------------------------------------
// Asset model — what the caller hands over. The picker derives which target
// slot kinds are valid from `kind`.
// ---------------------------------------------------------------------------

export type AttachableAsset = {
  /** Mime category. Drives which slots the picker offers. */
  kind: "audio" | "image" | "video";
  /** Source URL (Supabase, blob, https — anything fetchable). */
  url: string;
  /** Optional ElevenLabs voice name (audio only). */
  voiceName?: string;
  /** Transcript of the audio asset (audio only). */
  text?: string;
  /** Duration in seconds (audio only). */
  durationSec?: number;
  /** Image prompt used to generate the asset (image only). */
  prompt?: string;
  /** Pretty label shown at the top of the dialog. Defaults to a generic. */
  label?: string;
};

// What targets does this asset kind support?
function targetsForKind(kind: AttachableAsset["kind"]): AttachTarget["kind"][] {
  if (kind === "audio") return ["mainVo", "cutVo", "avatarClip"];
  if (kind === "image") return ["avatarImage"];
  return ["avatarLipsync"]; // video
}

// ---------------------------------------------------------------------------
// Trigger button — full version
// ---------------------------------------------------------------------------

type ButtonProps = {
  asset: AttachableAsset;
  className?: string;
  size?: "sm" | "md";
  /** Override the button label. */
  label?: string;
  /** Hide the icon and render text-only. */
  iconOnly?: boolean;
  /** Fires after a successful attach, with the picked target. */
  onAttached?: (target: AttachTarget) => void;
};

export function AttachToBriefButton({
  asset,
  className,
  size = "sm",
  label,
  iconOnly,
  onAttached,
}: ButtonProps) {
  const [open, setOpen] = useState(false);
  const [recentTarget, setRecentTarget] = useState<AttachTarget | null>(null);
  const [toast, setToast] = useState<{ target: AttachTarget; briefName: string } | null>(null);

  const padding = size === "sm" ? "px-2.5 py-1.5" : "px-3 py-2";
  const text = size === "sm" ? "text-xs" : "text-sm";

  // Auto-dismiss toast after 3.2s.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          `inline-flex items-center gap-1.5 bg-pf-soft border border-pf-border hover:border-pf-accent text-pf-text rounded-md ${padding} ${text} font-medium transition-colors`
        }
        title="Rattacher à un brief existant"
      >
        {recentTarget ? <Check size={13} className="text-pf-ok" /> : <Paperclip size={13} />}
        {!iconOnly && <span>{label ?? "Rattacher au brief"}</span>}
      </button>

      {open ? (
        <AttachDialog
          asset={asset}
          onClose={() => setOpen(false)}
          onAttached={(t) => {
            setRecentTarget(t);
            // Look up brief name for the toast (best-effort; falls back to id).
            const b = loadBrief(t.briefId);
            setToast({ target: t, briefName: b?.adsetName ?? "brief" });
            onAttached?.(t);
            setOpen(false);
          }}
        />
      ) : null}

      {toast && <AttachToast toast={toast} onDismiss={() => setToast(null)} />}
    </>
  );
}

// Sticky bottom-right confirmation pill. Lives inside the button instance
// so each click renders its own toast — no global state, no provider.
function AttachToast({
  toast,
  onDismiss,
}: {
  toast: { target: AttachTarget; briefName: string };
  onDismiss: () => void;
}) {
  const hookLabel = (() => {
    const b = loadBrief(toast.target.briefId);
    if (!b) return null;
    const h = b.hooks.find((x) => x.id === toast.target.hookId);
    if (!h) return null;
    return h.index === 1 ? "V1" : `Hook ${h.index}`;
  })();

  return (
    <div
      className="fixed bottom-5 right-5 z-[110] pf-slide-up bg-pf-elev border border-pf-ok/50 rounded-xl shadow-2xl shadow-black/50 max-w-sm flex items-stretch overflow-hidden"
      role="status"
    >
      <div className="bg-pf-ok/15 px-3 flex items-center justify-center">
        <Check size={18} className="text-pf-ok pf-success-pop" />
      </div>
      <div className="px-3 py-2.5 min-w-0">
        <div className="text-xs font-semibold truncate">Asset rattaché</div>
        <div className="text-[11px] text-pf-dim truncate">
          <span className="text-pf-text">{toast.briefName}</span>
          {hookLabel && <span className="text-pf-muted"> · {hookLabel}</span>}
          <span className="text-pf-muted"> · {attachTargetLabel(toast.target.kind)}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="px-2.5 text-pf-muted hover:text-pf-text border-l border-pf-border transition-colors"
        aria-label="Fermer"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog — exported separately so callers can mount it themselves if they
// prefer custom triggers (e.g. a thumbnail click instead of a button).
// ---------------------------------------------------------------------------

type DialogProps = {
  asset: AttachableAsset;
  onClose: () => void;
  onAttached: (target: AttachTarget) => void;
};

export function AttachDialog({ asset, onClose, onAttached }: DialogProps) {
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [briefId, setBriefId] = useState<string | null>(null);
  const [hookId, setHookId] = useState<string | null>(null);
  const [kind, setKind] = useState<AttachTarget["kind"] | null>(null);
  const [avatarId, setAvatarId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load briefs once on mount. We hydrate state so the user lands on a
  // sensible default (most recent brief, hook V1, first valid slot).
  useEffect(() => {
    const all = loadBriefs();
    setBriefs(all);
    if (all.length > 0) {
      const b = all[0];
      setBriefId(b.id);
      const h = b.hooks[0];
      if (h) {
        setHookId(h.id);
      }
    }
  }, []);

  const validKinds = useMemo(() => targetsForKind(asset.kind), [asset.kind]);

  // When brief/hook changes, reset kind to the first that's available
  // given the brief's avatar configuration (which may vary per hook).
  useEffect(() => {
    if (!briefId) return;
    const b = briefs.find((x) => x.id === briefId);
    if (!b) return;
    const hasAvatars = briefHasAvatars(b);
    const firstKind = validKinds.find((k) => {
      if (k === "mainVo" || k === "cutVo") return true;
      return hasAvatars;
    });
    setKind(firstKind ?? null);
    if (hasAvatars) {
      const h = b.hooks.find((x) => x.id === hookId) ?? b.hooks[0];
      setAvatarId(h?.avatars[0]?.id ?? null);
    } else {
      setAvatarId(null);
    }
  }, [briefId, hookId, briefs, validKinds]);

  const brief = useMemo(
    () => briefs.find((b) => b.id === briefId) ?? null,
    [briefs, briefId],
  );
  const hook = useMemo(
    () => brief?.hooks.find((h) => h.id === hookId) ?? null,
    [brief, hookId],
  );

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canSubmit =
    !!brief &&
    !!hook &&
    !!kind &&
    (kind === "mainVo" || kind === "cutVo" || !!avatarId);

  // The currently-targeted slot (if the user has narrowed down enough)
  // and whatever's already in it. Drives the "Rempli / Vide" preview
  // block below the picker AND the "Rattacher" vs "Remplacer" submit
  // label so the user always knows what they're about to do.
  const currentTarget: AttachTarget | null = useMemo(() => {
    if (!brief || !hook || !kind) return null;
    if (kind === "mainVo" || kind === "cutVo") {
      return { kind, briefId: brief.id, hookId: hook.id };
    }
    if (!avatarId) return null;
    return { kind, briefId: brief.id, hookId: hook.id, avatarId };
  }, [brief, hook, kind, avatarId]);

  const currentValue = useMemo(
    () => (currentTarget ? getAttachValue(currentTarget) : null),
    // We also want this to re-run after a clear / attach.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentTarget, briefs],
  );
  const slotFilled = !!currentValue?.url;

  const handleSubmit = useCallback(() => {
    if (!currentTarget) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = applyAttach(currentTarget, {
        url: asset.url,
        voiceName: asset.voiceName,
        text: asset.text,
        durationSec: asset.durationSec,
        prompt: asset.prompt,
      });
      if (!result) {
        setError("Échec du rattachement (brief introuvable)");
        setSubmitting(false);
        return;
      }
      onAttached(currentTarget);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }, [asset, currentTarget, onAttached]);

  const handleClear = useCallback(() => {
    if (!currentTarget) return;
    const r = clearAttach(currentTarget);
    if (r) {
      // Refresh local briefs state so currentValue recomputes empty.
      setBriefs(loadBriefs());
    }
  }, [currentTarget]);

  // ----- Render

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/75 backdrop-blur-sm flex items-center justify-center px-4"
      onClick={onClose}
    >
      <div
        className="bg-pf-elev border border-pf-border rounded-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-pf-border">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-md bg-pf-accent/15 border border-pf-accent/30 text-pf-accent flex items-center justify-center shrink-0">
              <AssetIcon kind={asset.kind} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">
                Rattacher {assetLabel(asset)}
              </div>
              {asset.voiceName && (
                <div className="text-[11px] text-pf-muted truncate">
                  Voix : {asset.voiceName}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-md hover:bg-pf-soft text-pf-muted hover:text-pf-text flex items-center justify-center transition-colors"
            aria-label="Fermer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {briefs.length === 0 ? (
            <EmptyState onClose={onClose} />
          ) : (
            <>
              <Section label="1. Brief">
                <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1 -mr-1">
                  {briefs.map((b) => (
                    <BriefRow
                      key={b.id}
                      brief={b}
                      validKinds={validKinds}
                      active={b.id === briefId}
                      onPick={() => {
                        setBriefId(b.id);
                        setHookId(b.hooks[0]?.id ?? null);
                      }}
                    />
                  ))}
                </div>
              </Section>

              {brief && (
                <Section label="2. Hook">
                  <div className="grid grid-cols-3 gap-2">
                    {brief.hooks.map((h) => (
                      <HookChip
                        key={h.id}
                        hook={h}
                        validKinds={validKinds}
                        active={h.id === hookId}
                        onPick={() => setHookId(h.id)}
                      />
                    ))}
                  </div>
                </Section>
              )}

              {brief && hook && (
                <Section label="3. Slot">
                  <SlotPicker
                    asset={asset}
                    brief={brief}
                    hook={hook}
                    validKinds={validKinds}
                    kind={kind}
                    avatarId={avatarId}
                    onPickKind={setKind}
                    onPickAvatar={setAvatarId}
                  />
                </Section>
              )}

              {/* Current-slot preview — shows what's already attached at
                  the resolved target (if anything) so the user knows
                  before clicking Rattacher whether it's a fresh write
                  or an overwrite. The "Vider" button frees the slot
                  in-place. */}
              {currentTarget && slotFilled && currentValue && (
                <SlotPreview
                  asset={asset}
                  value={currentValue}
                  onClear={handleClear}
                />
              )}

              {error && (
                <div className="bg-pf-danger/10 border border-pf-danger/40 text-pf-danger text-xs rounded-lg px-3 py-2">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {briefs.length > 0 && (
          <div className="px-5 py-3 border-t border-pf-border bg-pf-bg/40 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onClose}
              className="text-xs text-pf-muted hover:text-pf-text px-2 py-1.5 transition-colors"
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit || submitting}
              className={`font-semibold rounded-md px-4 py-2 text-sm inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${
                slotFilled
                  ? "bg-pf-warn text-pf-bg hover:bg-pf-warn/90"
                  : "bg-pf-accent text-pf-accent-fg hover:bg-pf-accent/90"
              }`}
              title={
                slotFilled
                  ? "Ce slot contient déjà un asset — il sera remplacé."
                  : undefined
              }
            >
              {submitting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Check size={14} />
              )}
              {slotFilled ? "Remplacer" : "Rattacher"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subviews
// ---------------------------------------------------------------------------

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-pf-muted font-semibold mb-2">
        {label}
      </div>
      {children}
    </div>
  );
}

function BriefRow({
  brief,
  validKinds,
  active,
  onPick,
}: {
  brief: Brief;
  validKinds: AttachTarget["kind"][];
  active: boolean;
  onPick: () => void;
}) {
  const hasAvatars = briefHasAvatars(brief);
  const Icon = hasAvatars ? Users : FileText;
  // Aggregate fill across the 3 hooks for the asset type being attached.
  const fill = briefFillForKind(brief, validKinds);
  const allFilled = fill.total > 0 && fill.filled === fill.total;
  return (
    <button
      type="button"
      onClick={onPick}
      className={`w-full flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
        active
          ? "border-pf-accent bg-pf-accent/10"
          : "border-pf-border bg-pf-bg hover:border-pf-accent/60"
      }`}
    >
      <div
        className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
          active
            ? "bg-pf-accent/20 text-pf-accent"
            : "bg-pf-soft border border-pf-border text-pf-accent"
        }`}
      >
        <Icon size={13} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{brief.adsetName}</div>
        <div className="text-[10px] text-pf-muted font-mono">
          3 hooks{hasAvatars ? ` · ${totalAvatars(brief)} avatars` : ""}
        </div>
      </div>
      {fill.total > 0 && (
        <span
          className={`shrink-0 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border ${
            allFilled
              ? "bg-pf-ok/15 text-pf-ok border-pf-ok/40"
              : fill.filled > 0
                ? "bg-pf-warn/15 text-pf-warn border-pf-warn/40"
                : "bg-pf-soft text-pf-muted border-pf-border"
          }`}
          title={`${fill.filled} slot(s) rempli(s) sur ${fill.total} pour cet asset`}
        >
          {fill.filled}/{fill.total}
        </span>
      )}
      {active && <Check size={14} className="text-pf-accent shrink-0" />}
    </button>
  );
}

function totalAvatars(b: Brief): number {
  return b.hooks.reduce((acc, h) => acc + h.avatars.length, 0);
}

function HookChip({
  hook,
  validKinds,
  active,
  onPick,
}: {
  hook: HookBrief;
  validKinds: AttachTarget["kind"][];
  active: boolean;
  onPick: () => void;
}) {
  const label = hook.index === 1 ? "V1" : `Hook ${hook.index}`;
  // Aggregate fill for the asset type across this hook's slots.
  let filled = 0;
  let total = 0;
  for (const k of validKinds) {
    const c = hookFillForKind(hook, k);
    filled += c.filled;
    total += c.total;
  }
  const allFilled = total > 0 && filled === total;
  const someFilled = filled > 0 && !allFilled;
  return (
    <button
      type="button"
      onClick={onPick}
      className={`relative rounded-lg border-2 px-2 py-2.5 text-sm font-semibold transition-colors ${
        active
          ? "border-pf-accent bg-pf-accent/15 text-pf-accent"
          : "border-pf-border bg-pf-bg hover:border-pf-accent/60 text-pf-text"
      }`}
    >
      <div>{label}</div>
      {total > 0 && (
        <div
          className={`text-[10px] font-mono mt-0.5 ${
            allFilled ? "text-pf-ok" : someFilled ? "text-pf-warn" : "text-pf-muted"
          }`}
        >
          {filled}/{total}
        </div>
      )}
    </button>
  );
}

function SlotPicker({
  asset,
  brief,
  hook,
  validKinds,
  kind,
  avatarId,
  onPickKind,
  onPickAvatar,
}: {
  asset: AttachableAsset;
  brief: Brief;
  hook: HookBrief;
  validKinds: AttachTarget["kind"][];
  kind: AttachTarget["kind"] | null;
  avatarId: string | null;
  onPickKind: (k: AttachTarget["kind"]) => void;
  onPickAvatar: (id: string) => void;
}) {
  // Hide avatar-requiring slots when the hook has no avatars (per-hook
  // avatar counts can vary, so we check the actual hook not the brief).
  const hookHasAvatars = hook.avatars.length > 0;
  const offered = validKinds.filter((k) => {
    if (k === "avatarClip" || k === "avatarImage" || k === "avatarLipsync") {
      return hookHasAvatars;
    }
    return true;
  });

  if (offered.length === 0) {
    return (
      <div className="bg-pf-bg border border-dashed border-pf-border rounded-lg px-3 py-3 text-xs text-pf-dim">
        Ce hook n&apos;a aucun avatar IA configuré.{" "}
        {asset.kind === "image" || asset.kind === "video"
          ? "Choisis un autre hook ou ajoute des avatars dans le wizard du brief."
          : "Cet asset n'a pas de slot compatible."}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        {offered.map((k) => {
          const c = hookFillForKind(hook, k);
          return (
            <KindChip
              key={k}
              kind={k}
              fill={c}
              active={k === kind}
              onPick={() => onPickKind(k)}
            />
          );
        })}
      </div>

      {kind &&
        (kind === "avatarClip" || kind === "avatarImage" || kind === "avatarLipsync") && (
          <div className="space-y-1.5">
            <div className="text-[11px] text-pf-muted">Avatar :</div>
            <div className="grid grid-cols-3 gap-2">
              {hook.avatars.map((a, i) => {
                const filled =
                  (kind === "avatarClip" && !!a.voClipUrl) ||
                  (kind === "avatarImage" && !!a.imageUrl) ||
                  (kind === "avatarLipsync" && !!a.lipsyncVideoUrl);
                const isActive = a.id === avatarId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => onPickAvatar(a.id)}
                    className={`relative text-xs rounded-md border-2 px-2 py-1.5 truncate transition-colors ${
                      isActive
                        ? "border-pf-accent bg-pf-accent/15 text-pf-accent"
                        : filled
                          ? "border-pf-ok/40 bg-pf-ok/10 text-pf-text hover:border-pf-ok"
                          : "border-pf-border bg-pf-bg hover:border-pf-accent/60"
                    }`}
                    title={filled ? "Cet avatar a déjà cet asset" : undefined}
                  >
                    Avt {i + 1}
                    {filled && (
                      <span
                        className={`absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full ${
                          isActive ? "bg-pf-accent" : "bg-pf-ok"
                        }`}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
    </div>
  );
}

function KindChip({
  kind,
  fill,
  active,
  onPick,
}: {
  kind: AttachTarget["kind"];
  fill: FillCount;
  active: boolean;
  onPick: () => void;
}) {
  const label = attachTargetLabel(kind);
  const allFilled = fill.total > 0 && fill.filled === fill.total;
  const someFilled = fill.filled > 0 && !allFilled;
  return (
    <button
      type="button"
      onClick={onPick}
      className={`relative text-xs rounded-lg border-2 px-2.5 py-2 text-left transition-colors ${
        active
          ? "border-pf-accent bg-pf-accent/15 text-pf-accent"
          : allFilled
            ? "border-pf-ok/40 bg-pf-ok/10 text-pf-text hover:border-pf-ok"
            : "border-pf-border bg-pf-bg hover:border-pf-accent/60 text-pf-text"
      }`}
    >
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <KindIcon kind={kind} />
          <span className="font-medium truncate">{label}</span>
        </div>
        {fill.total > 1 && (
          <span
            className={`text-[10px] font-mono shrink-0 ${
              allFilled ? "text-pf-ok" : someFilled ? "text-pf-warn" : "text-pf-muted"
            }`}
          >
            {fill.filled}/{fill.total}
          </span>
        )}
        {fill.total === 1 && fill.filled === 1 && (
          <span className="w-1.5 h-1.5 rounded-full bg-pf-ok shrink-0" />
        )}
      </div>
    </button>
  );
}

// Shows the asset currently sitting in the selected slot, plus a button
// to clear it. Replaces the "are you sure you want to overwrite?" prompt
// with an explicit "see what's there, vide it, then attach" affordance.
function SlotPreview({
  asset,
  value,
  onClear,
}: {
  asset: AttachableAsset;
  value: { url?: string; meta?: string };
  onClear: () => void;
}) {
  if (!value.url) return null;
  const isImage = asset.kind === "image";
  const isAudio = asset.kind === "audio";
  return (
    <div className="bg-pf-warn/10 border border-pf-warn/40 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wider text-pf-warn font-bold">
          Slot déjà rempli
        </div>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1 text-[11px] font-semibold bg-pf-soft border border-pf-border hover:border-pf-danger text-pf-text hover:text-pf-danger rounded-md px-2 py-1 transition-colors"
          title="Vider ce slot. Tu peux ensuite rattacher cet asset à la place."
        >
          <X size={11} />
          Vider
        </button>
      </div>
      <div className="flex items-start gap-3">
        {isImage && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={value.url}
            alt="Asset actuel"
            className="w-16 h-16 rounded-md object-cover border border-pf-border shrink-0"
          />
        )}
        {isAudio && (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <audio src={value.url} controls className="flex-1 h-8" />
        )}
        {!isImage && !isAudio && (
          <a
            href={value.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-pf-accent hover:underline truncate flex-1"
          >
            {value.url}
          </a>
        )}
        {value.meta && (
          <div className="text-[11px] text-pf-dim flex-1 min-w-0 leading-snug line-clamp-3">
            {value.meta}
          </div>
        )}
      </div>
      <div className="text-[11px] text-pf-dim leading-snug">
        Cliquer <strong>Remplacer</strong> en bas pour écraser cet asset par le
        nouveau, ou <strong>Vider</strong> ci-dessus pour libérer le slot sans
        rien rattacher.
      </div>
    </div>
  );
}

function KindIcon({ kind }: { kind: AttachTarget["kind"] }) {
  if (kind === "mainVo" || kind === "cutVo" || kind === "avatarClip") {
    return <Mic size={12} />;
  }
  if (kind === "avatarImage") return <ImageIcon size={12} />;
  return <Video size={12} />;
}

function AssetIcon({ kind }: { kind: AttachableAsset["kind"] }) {
  if (kind === "audio") return <Mic size={14} />;
  if (kind === "image") return <ImageIcon size={14} />;
  return <Video size={14} />;
}

function assetLabel(asset: AttachableAsset): string {
  if (asset.label) return asset.label;
  if (asset.kind === "audio") return "cette voix off";
  if (asset.kind === "image") return "cette image";
  return "cette vidéo";
}

function EmptyState({ onClose }: { onClose: () => void }) {
  return (
    <div className="text-center py-6">
      <div className="w-12 h-12 mx-auto rounded-2xl bg-pf-accent/15 border border-pf-accent/30 flex items-center justify-center text-pf-accent mb-3">
        <Sparkles size={20} />
      </div>
      <div className="text-sm font-semibold mb-1">Aucun brief encore</div>
      <p className="text-xs text-pf-muted max-w-xs mx-auto mb-4">
        Crée un brief avant de pouvoir y rattacher tes assets. Tu peux ensuite
        revenir ici en 1 clic.
      </p>
      <Link
        href="/briefs"
        onClick={onClose}
        className="inline-flex items-center gap-1.5 bg-pf-accent text-pf-accent-fg font-semibold rounded-md px-4 py-2 text-sm hover:bg-pf-accent/90 transition-colors"
      >
        <Plus size={14} />
        Créer un brief
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UploadAndAttachButton — drop a file from your PC into a brief in one go.
//
// Click → native file picker (image/video/audio) → POST /api/upload to
// Supabase Storage → opens the same AttachDialog the gallery uses, but
// pre-loaded with the freshly uploaded asset's URL. The user picks
// brief / hook / slot exactly like for a generated asset.
//
// This is the fast path for assets you already have on your machine
// (a screenshot, a stock photo, a phone recording, etc.) — no need to
// open /prompts and re-generate it just to attach.
// ---------------------------------------------------------------------------

type UploadButtonProps = {
  /** Filter the native file picker. Defaults to all image types. */
  accept?: string;
  /** Override the button label. */
  label?: string;
  className?: string;
  /** Pre-determine what kind of asset to expect — defaults derived from
   *  the picked file's MIME type. */
  kindHint?: AttachableAsset["kind"];
  /** Optional callback after a successful attach. */
  onAttached?: (target: AttachTarget) => void;
};

export function UploadAndAttachButton({
  accept = "image/png,image/jpeg,image/jpg,image/webp",
  label = "Uploader une image",
  className,
  kindHint,
  onAttached,
}: UploadButtonProps) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAsset, setPendingAsset] = useState<AttachableAsset | null>(null);

  const handlePick = useCallback(
    async (file: File) => {
      setError(null);
      setUploading(true);
      try {
        const url = await uploadFileToStorage(file);
        const kind: AttachableAsset["kind"] =
          kindHint ??
          (file.type.startsWith("video/")
            ? "video"
            : file.type.startsWith("audio/")
              ? "audio"
              : "image");
        setPendingAsset({
          kind,
          url,
          label: file.name,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
      }
    },
    [kindHint],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        disabled={uploading}
        className={
          className ??
          "inline-flex items-center gap-2 bg-pf-soft border border-pf-border hover:border-pf-accent rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-40"
        }
        title="Choisir une image depuis ton PC et la rattacher à un brief"
      >
        {uploading ? (
          <Loader2 size={15} className="animate-spin" />
        ) : (
          <Upload size={15} />
        )}
        {uploading ? "Upload…" : label}
      </button>
      <input
        ref={fileInput}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Reset the input so re-picking the same file fires onChange.
          e.target.value = "";
          if (f) void handlePick(f);
        }}
      />
      {error && (
        <span className="text-xs text-pf-danger ml-2">{error}</span>
      )}
      {pendingAsset && (
        <AttachDialog
          asset={pendingAsset}
          onClose={() => setPendingAsset(null)}
          onAttached={(t) => {
            onAttached?.(t);
            setPendingAsset(null);
          }}
        />
      )}
    </>
  );
}

// Tiny re-export so the bare `ImagePlus` icon is reachable from callers
// who want a smaller variant of the upload button.
export { ImagePlus };
