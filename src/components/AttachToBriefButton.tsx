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

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Check,
  FileText,
  ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  Sparkles,
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
  loadBrief,
  loadBriefs,
} from "@/lib/briefs";

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

  // When brief/hook changes, reset kind to the first that's available given
  // the brief's avatar count.
  useEffect(() => {
    if (!briefId) return;
    const b = briefs.find((x) => x.id === briefId);
    if (!b) return;
    const hasAvatars = b.avatarCount > 0;
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

  const handleSubmit = useCallback(() => {
    if (!brief || !hook || !kind) return;
    setSubmitting(true);
    setError(null);
    try {
      const target: AttachTarget =
        kind === "mainVo" || kind === "cutVo"
          ? { kind, briefId: brief.id, hookId: hook.id }
          : { kind, briefId: brief.id, hookId: hook.id, avatarId: avatarId! };

      const result = applyAttach(target, {
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
      onAttached(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }, [asset, avatarId, brief, hook, kind, onAttached]);

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
              className="bg-pf-accent text-pf-accent-fg font-semibold rounded-md px-4 py-2 text-sm inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-pf-accent/90 transition-colors"
            >
              {submitting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Check size={14} />
              )}
              Rattacher
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
  active,
  onPick,
}: {
  brief: Brief;
  active: boolean;
  onPick: () => void;
}) {
  const hasAvatars = brief.avatarCount > 0;
  const Icon = hasAvatars ? Users : FileText;
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
          {hasAvatars ? `3 hooks × ${brief.avatarCount} av.` : "3 hooks"}
        </div>
      </div>
      {active && <Check size={14} className="text-pf-accent shrink-0" />}
    </button>
  );
}

function HookChip({
  hook,
  active,
  onPick,
}: {
  hook: HookBrief;
  active: boolean;
  onPick: () => void;
}) {
  const label = hook.index === 1 ? "V1" : `Hook ${hook.index}`;
  const filled = !!hook.cutVoUrl || !!hook.hookScript.trim();
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
      {label}
      {filled && (
        <span
          className={`absolute top-1 right-1 w-1.5 h-1.5 rounded-full ${
            active ? "bg-pf-accent" : "bg-pf-ok"
          }`}
        />
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
  const hasAvatars = brief.avatarCount > 0;

  // Hide avatar-requiring slots when the brief has no avatars
  const offered = validKinds.filter((k) => {
    if (k === "avatarClip" || k === "avatarImage" || k === "avatarLipsync") {
      return hasAvatars;
    }
    return true;
  });

  if (offered.length === 0) {
    return (
      <div className="bg-pf-bg border border-dashed border-pf-border rounded-lg px-3 py-3 text-xs text-pf-dim">
        Ce brief n&apos;a aucun avatar IA configuré.{" "}
        {asset.kind === "image" || asset.kind === "video"
          ? "Augmente le nombre d'avatars dans le brief pour pouvoir rattacher cet asset."
          : "Cet asset n'a pas de slot compatible."}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        {offered.map((k) => (
          <KindChip
            key={k}
            kind={k}
            active={k === kind}
            onPick={() => onPickKind(k)}
          />
        ))}
      </div>

      {kind &&
        (kind === "avatarClip" || kind === "avatarImage" || kind === "avatarLipsync") && (
          <div className="space-y-1.5">
            <div className="text-[11px] text-pf-muted">Avatar :</div>
            <div className="grid grid-cols-3 gap-2">
              {hook.avatars.map((a, i) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onPickAvatar(a.id)}
                  className={`text-xs rounded-md border-2 px-2 py-1.5 truncate transition-colors ${
                    a.id === avatarId
                      ? "border-pf-accent bg-pf-accent/15 text-pf-accent"
                      : "border-pf-border bg-pf-bg hover:border-pf-accent/60"
                  }`}
                >
                  Avt {i + 1}
                </button>
              ))}
            </div>
          </div>
        )}
    </div>
  );
}

function KindChip({
  kind,
  active,
  onPick,
}: {
  kind: AttachTarget["kind"];
  active: boolean;
  onPick: () => void;
}) {
  const label = attachTargetLabel(kind);
  return (
    <button
      type="button"
      onClick={onPick}
      className={`text-xs rounded-lg border-2 px-2.5 py-2 text-left transition-colors ${
        active
          ? "border-pf-accent bg-pf-accent/15 text-pf-accent"
          : "border-pf-border bg-pf-bg hover:border-pf-accent/60 text-pf-text"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <KindIcon kind={kind} />
        <span className="font-medium truncate">{label}</span>
      </div>
    </button>
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
