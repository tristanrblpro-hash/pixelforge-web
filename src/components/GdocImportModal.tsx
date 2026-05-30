"use client";

// GdocImportModal — paste a Google Doc with the user's standard ad-brief
// format, get a live preview of every ad parsed out, then create the
// briefs in one click. Used by Step 1 of BriefBatchWizard to skip the
// whole "type each name, type each script" loop.

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ClipboardPaste,
  FileText,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";

import { type Brief, newAvatar, newBrief, upsertBrief } from "@/lib/briefs";
import {
  buildHookScripts,
  parseGoogleDoc,
  type ParsedAd,
} from "@/lib/gdocParser";

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

type Props = {
  /** Default avatar count applied to every created brief. The user can
   *  still tweak per row in Step 1 after import. */
  defaultAvatarCount: number;
  onClose: () => void;
  /** Called with the list of brief IDs created in localStorage. The wizard
   *  uses this to push DraftRows and jump to a later step. */
  onImported: (briefs: Brief[]) => void;
};

export function GdocImportModal({ defaultAvatarCount, onClose, onImported }: Props) {
  const [raw, setRaw] = useState("");
  const [avatarCount, setAvatarCount] = useState(defaultAvatarCount);
  const [importing, setImporting] = useState(false);

  // Live-parse as the user types/pastes.
  const parsed = useMemo(() => parseGoogleDoc(raw), [raw]);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleImport = () => {
    if (parsed.ads.length === 0) return;
    setImporting(true);
    try {
      const created: Brief[] = [];
      for (const ad of parsed.ads) {
        const adsetName = `${ad.briefName} - ${ad.creativeName}`.trim();
        // If the doc specifies per-hook avatar counts, use them as the
        // authoritative shape; otherwise fall back to the modal's
        // default slider applied uniformly. brief.avatarCount holds the
        // max so legacy uniform-resize calls don't crop the largest hook.
        const perHook = ad.avatarsPerHook;
        const briefAvatarMax = perHook ? Math.max(...perHook) : avatarCount;
        const b = newBrief({ avatarCount: briefAvatarMax, adsetName });
        b.creativeRef = ad.creativeRef;
        const { v1, h2, h3 } = buildHookScripts(ad);
        if (b.hooks[0]) b.hooks[0].hookScript = v1;
        if (b.hooks[1]) b.hooks[1].hookScript = h2;
        if (b.hooks[2]) b.hooks[2].hookScript = h3;
        b.baseScript = v1; // store for reference

        // Resize each hook's avatar slots independently when the doc
        // specifies per-hook counts. newBrief sized everything uniformly
        // to briefAvatarMax above; we re-trim/grow per hook here.
        if (perHook) {
          for (let i = 0; i < 3; i++) {
            const target = perHook[i];
            const hook = b.hooks[i];
            if (!hook) continue;
            if (target <= 0) {
              hook.avatars = [];
            } else {
              hook.avatars = Array.from({ length: target }, (_, j) =>
                newAvatar(`Avatar IA ${j + 1}`),
              );
            }
          }
        }

        // Scene setups (UPPERCASE lines like "HOMME DERMATO LUNETTE #1")
        // are stripped from the script by the parser. We surface them as
        // per-hook filming notes so the monteur sees them in Notion
        // without the TTS reading them aloud.
        if (ad.scenes.length > 0) {
          const notesText = formatScenesAsNotes(ad.scenes);
          for (const h of b.hooks) {
            h.notes = notesText;
          }
        }
        const saved = upsertBrief(b);
        created.push(saved);
      }
      onImported(created);
    } finally {
      setImporting(false);
    }
  };

  const adsCount = parsed.ads.length;
  const okCount = parsed.ads.filter(
    (a) => a.hook1Line && a.hook2Line && a.hook3Line,
  ).length;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-md flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-pf-elev border border-pf-border rounded-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-pf-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-pf-accent/15 border border-pf-accent/30 text-pf-accent flex items-center justify-center">
              <ClipboardPaste size={18} />
            </div>
            <div>
              <h2 className="text-lg font-bold">Importer depuis un Google Doc</h2>
              <p className="text-sm text-pf-dim">
                Colle le doc, on remplit tous les briefs + scripts + hooks
                automatiquement.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 rounded-lg hover:bg-pf-soft text-pf-muted hover:text-pf-text flex items-center justify-center transition-colors"
            aria-label="Fermer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body: 2 columns — left paste / right preview */}
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 overflow-hidden">
          {/* Paste column */}
          <div className="border-r border-pf-border p-5 flex flex-col gap-3 overflow-hidden">
            <div className="flex items-center justify-between">
              <label className="text-sm font-bold uppercase tracking-wider text-pf-muted">
                Colle le doc ici
              </label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-pf-muted" title="Utilisé seulement quand le doc ne contient pas de ligne 'Avatars : V1=…, H2=…, H3=…'">
                  Avatars/brief par défaut :
                </span>
                <div className="flex items-center gap-1 bg-pf-bg border border-pf-border rounded-md p-0.5">
                  <button
                    type="button"
                    onClick={() => setAvatarCount(Math.max(0, avatarCount - 1))}
                    className="w-7 h-7 rounded text-pf-muted hover:text-pf-text hover:bg-pf-soft flex items-center justify-center"
                  >
                    −
                  </button>
                  <span className="font-mono text-base font-bold w-7 text-center">
                    {avatarCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setAvatarCount(Math.min(5, avatarCount + 1))}
                    className="w-7 h-7 rounded text-pf-muted hover:text-pf-text hover:bg-pf-soft flex items-center justify-center"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={EXAMPLE_PLACEHOLDER}
              className="flex-1 bg-pf-bg border border-pf-border rounded-xl px-4 py-3 text-sm font-mono leading-relaxed focus:outline-none focus:border-pf-accent resize-none"
              spellCheck={false}
            />
            <div className="text-xs text-pf-muted leading-relaxed space-y-1">
              <div>
                Format : <code>Ad Test #N - Créa</code> puis{" "}
                <code>Référence:</code> (URL), <code>Avatars : V1=2, H2=1, H3=0</code>,
                corps du script, et 3 hooks terminaux{" "}
                <code>Ad #N - Créa - Hook N</code>.
              </div>
              <div>
                Astuce notes perso : préfixe une ligne par{" "}
                <code className="text-pf-accent">*</code> pour qu&apos;elle soit
                totalement ignorée (ni en VO, ni dans Notion).
              </div>
            </div>
          </div>

          {/* Preview column */}
          <div className="p-5 flex flex-col gap-3 overflow-hidden">
            <div className="flex items-center justify-between">
              <label className="text-sm font-bold uppercase tracking-wider text-pf-muted">
                Aperçu
              </label>
              {raw.trim() ? (
                <div className="flex items-center gap-1.5 text-sm font-semibold">
                  <span className="text-pf-ok">{okCount}</span>
                  <span className="text-pf-muted">/</span>
                  <span>{adsCount}</span>
                  <span className="text-pf-muted text-xs">complets</span>
                </div>
              ) : null}
            </div>

            <div className="flex-1 overflow-y-auto pr-2 space-y-2.5">
              {!raw.trim() && (
                <div className="bg-pf-bg border border-dashed border-pf-border rounded-xl p-6 text-center">
                  <FileText size={28} className="mx-auto text-pf-muted mb-3" />
                  <p className="text-sm text-pf-dim">
                    L&apos;aperçu s&apos;affichera ici dès que tu commenceras à
                    coller.
                  </p>
                </div>
              )}

              {raw.trim() && adsCount === 0 && (
                <div className="bg-pf-danger/10 border border-pf-danger/40 rounded-xl p-4">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle size={16} className="text-pf-danger shrink-0 mt-0.5" />
                    <div>
                      <div className="text-sm font-semibold text-pf-danger mb-1">
                        Aucun brief détecté
                      </div>
                      <p className="text-xs text-pf-dim leading-relaxed">
                        Vérifie qu&apos;au moins une ligne ressemble à{" "}
                        <code>Ad Test #1 - Nom de la créa</code>.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {parsed.ads.map((ad, i) => (
                <AdPreview key={i} ad={ad} />
              ))}

              {parsed.warnings.length > 0 && (
                <div className="bg-pf-warn/10 border border-pf-warn/40 rounded-xl p-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-pf-warn mb-1.5">
                    Avertissements ({parsed.warnings.length})
                  </div>
                  <ul className="text-xs text-pf-dim space-y-0.5 leading-relaxed">
                    {parsed.warnings.map((w, i) => (
                      <li key={i}>• {w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-pf-border bg-pf-bg/40 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-pf-muted hover:text-pf-text px-3 py-2 transition-colors"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={adsCount === 0 || importing}
            className="bg-pf-accent text-pf-accent-fg font-bold rounded-lg px-5 py-2.5 text-sm inline-flex items-center gap-2 disabled:opacity-40 hover:bg-pf-accent/90 transition-colors"
          >
            {importing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            Créer {adsCount} brief{adsCount > 1 ? "s" : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

function AdPreview({ ad }: { ad: ParsedAd }) {
  const complete = !!ad.hook1Line && !!ad.hook2Line && !!ad.hook3Line;
  return (
    <div
      className={`bg-pf-bg border rounded-xl p-3.5 ${
        complete ? "border-pf-ok/40" : "border-pf-border"
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-bold truncate">
            {ad.briefName} — {ad.creativeName}
          </div>
          {ad.creativeRef && (
            <a
              href={ad.creativeRef}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-pf-accent truncate block hover:underline"
            >
              {ad.creativeRef}
            </a>
          )}
        </div>
        {complete ? (
          <span className="inline-flex items-center gap-1 text-xs font-bold bg-pf-ok/15 text-pf-ok border border-pf-ok/40 rounded px-2 py-0.5 shrink-0">
            <Check size={11} />
            OK
          </span>
        ) : (
          <span className="inline-flex items-center text-xs font-semibold bg-pf-warn/15 text-pf-warn border border-pf-warn/40 rounded px-2 py-0.5 shrink-0">
            Incomplet
          </span>
        )}
      </div>

      <div className="space-y-1 text-xs">
        <HookLine n={1} label="Hook 1 (Original)" line={ad.hook1Line} />
        <HookLine n={2} label="Hook 2" line={ad.hook2Line} />
        <HookLine n={3} label="Hook 3" line={ad.hook3Line} />
      </div>

      {ad.avatarsPerHook && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
          <span className="text-pf-muted">Avatars :</span>
          <AvatarChip label="V1" n={ad.avatarsPerHook[0]} />
          <AvatarChip label="H2" n={ad.avatarsPerHook[1]} />
          <AvatarChip label="H3" n={ad.avatarsPerHook[2]} />
        </div>
      )}

      {ad.v1Script && (
        <div className="mt-2 text-[11px] text-pf-muted line-clamp-2 leading-relaxed">
          {ad.v1Script.slice(0, 180)}
          {ad.v1Script.length > 180 ? "…" : ""}
        </div>
      )}

      {ad.scenes.length > 0 && (
        <div className="mt-2 pt-2 border-t border-pf-border/60">
          <div className="text-[10px] uppercase tracking-wider text-pf-muted font-bold mb-1">
            Setups vidéo détectés ({ad.scenes.length}) — basculés en note monteur
          </div>
          <div className="flex flex-wrap gap-1">
            {ad.scenes.map((s, i) => (
              <span
                key={i}
                className="text-[10px] font-mono text-pf-dim bg-pf-soft border border-pf-border rounded px-1.5 py-0.5 truncate max-w-[200px]"
                title={s}
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Format the extracted scene markers as a readable note for the monteur.
// Surfaces as "Filming notes" block in Notion via brief.hook.notes.
function formatScenesAsNotes(scenes: string[]): string {
  const lines = scenes.map((s, i) => `${i + 1}. ${s}`);
  return `Setups vidéo (dans l'ordre du script) :\n${lines.join("\n")}`;
}

// Small chip used in the preview to show per-hook avatar counts.
function AvatarChip({ label, n }: { label: string; n: number }) {
  const tone = n === 0 ? "text-pf-muted bg-pf-soft" : "text-pf-accent bg-pf-accent/15";
  return (
    <span
      className={`inline-flex items-center gap-0.5 font-mono rounded px-1.5 py-0.5 border border-pf-border text-[10px] ${tone}`}
    >
      {label}=<span className="font-bold">{n}</span>
    </span>
  );
}

function HookLine({
  n,
  label,
  line,
}: {
  n: number;
  label: string;
  line?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span
        className={`shrink-0 w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center font-mono ${
          line
            ? "bg-pf-ok/15 text-pf-ok"
            : "bg-pf-muted/15 text-pf-muted"
        }`}
      >
        {n}
      </span>
      {line ? (
        <span className="text-pf-text italic line-clamp-2 leading-snug">
          “{line}”
        </span>
      ) : (
        <span className="text-pf-muted italic">{label} manquant</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Example placeholder shown in the empty textarea
// ---------------------------------------------------------------------------

const EXAMPLE_PLACEHOLDER = `Ad Test #1 - Anti-Fake Dermato

Référence: https://app.trendtrack.io/share/ads/...
Avatars : V1=2, H2=1, H3=0

* Note perso : à valider avec le client avant de lancer
* TODO : refaire le hook 3 plus émotionnel

HOMME DERMATO LUNETTE #1 :
Eye bags can actually get worse if you pick up a fake microneedle patch...

FEMME DERMATO ECRAN SPECIAL :
We spent countless hours researching and developing...

Ad #1 - Anti-Fake Dermato - Hook 1 (Original)
"Eye bags can actually get worse if you pick up a fake microneedle patch."

Ad #2 - Anti-Fake Dermato - Hook 2
"People keep asking if you're tired..."

Ad #3 - Anti-Fake Dermato - Hook 3
"Those heavy bags under your eyes..."

— autre brief —
Ad Test #2 - ...
`;
