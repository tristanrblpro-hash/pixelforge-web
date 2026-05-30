"use client";

// GdocImportModal — paste a Google Doc with the user's standard ad-brief
// format, get a live preview of every ad parsed out, then create the
// briefs in one click. Used by Step 1 of BriefBatchWizard to skip the
// whole "type each name, type each script" loop.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ClipboardPaste,
  Copy,
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

        // Compose each hook's filming notes from the parsed content:
        //   - Scene setups (UPPERCASE markers from V1 body) — shared
        //     across the 3 hooks since the video structure is the same.
        //   - Per-hook monteur notes (lines starting with `>`).
        // Both feed into Notion's "Filming notes" block via hook.notes.
        for (let i = 0; i < 3; i++) {
          const hook = b.hooks[i];
          if (!hook) continue;
          const personalNotes = ad.hookNotes[i] ?? [];
          const composed = composeFilmingNotes(ad.scenes, personalNotes);
          if (composed) hook.notes = composed;
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

        {/* Legend — the 5 conventions of the Google Doc, visible upfront
            so the user remembers each marker's role without reading docs. */}
        <Legend />

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
            <div className="text-xs text-pf-muted leading-relaxed">
              Plusieurs ads dans un seul doc → sépare-les juste par le prochain{" "}
              <code>Ad Test #N - …</code>. La légende ci-dessus rappelle les
              autres marqueurs.
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

      {ad.hookNotes.some((n) => n.length > 0) && (
        <div className="mt-2 pt-2 border-t border-pf-border/60">
          <div className="text-[10px] uppercase tracking-wider text-pf-muted font-bold mb-1">
            Notes monteur ({ad.hookNotes.reduce((acc, n) => acc + n.length, 0)})
          </div>
          <div className="space-y-0.5 text-[10px] text-pf-dim">
            {ad.hookNotes.map(
              (notes, idx) =>
                notes.length > 0 && (
                  <div key={idx} className="flex gap-1.5">
                    <span className="font-mono font-bold text-pf-accent shrink-0">
                      {idx === 0 ? "V1" : `H${idx + 1}`}
                    </span>
                    <span className="line-clamp-2 leading-snug">
                      {notes.join(" · ")}
                    </span>
                  </div>
                ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Compose the two sources of per-hook filming-notes into one readable
// block: scene setups (numbered list, from UPPERCASE markers in the V1
// body) + monteur notes (bulleted list, from `>` lines). Returns "" if
// both are empty so the caller can skip setting hook.notes entirely.
function composeFilmingNotes(scenes: string[], notes: string[]): string {
  const sections: string[] = [];
  if (scenes.length > 0) {
    const list = scenes.map((s, i) => `${i + 1}. ${s}`).join("\n");
    sections.push(`Setups vidéo (dans l'ordre du script) :\n${list}`);
  }
  if (notes.length > 0) {
    const list = notes.map((n) => `- ${n}`).join("\n");
    sections.push(`Notes monteur :\n${list}`);
  }
  return sections.join("\n\n");
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

// ---------------------------------------------------------------------------
// Legend strip — visible cheat sheet of the 5 conventions used in the
// Google Doc. Sits between the modal header and the paste/preview body.
// ---------------------------------------------------------------------------

type LegendItem = {
  marker: string;
  /** Tailwind colour classes applied to the marker chip. */
  chipClass: string;
  title: string;
  body: string;
};

const LEGEND_ITEMS: LegendItem[] = [
  {
    marker: "*",
    chipClass: "bg-pf-soft text-pf-muted line-through decoration-pf-muted/60",
    title: "Note perso",
    body: "Ignorée partout. Pour tes mémos d'organisation.",
  },
  {
    marker: ">",
    chipClass: "bg-pf-accent/15 text-pf-accent border-pf-accent/40",
    title: "Note monteur",
    body: "Atterrit dans Filming notes de Notion, par hook.",
  },
  {
    marker: "ABC",
    chipClass: "bg-pf-warn/15 text-pf-warn border-pf-warn/40 font-bold",
    title: "Setup vidéo",
    body: "Ligne EN MAJUSCULES = scène. Strippée du VO, mise dans Filming notes.",
  },
  {
    marker: "Réf:",
    chipClass: "bg-pf-soft text-pf-text border-pf-border",
    title: "Métadonnées",
    body: "Référence: / Avatars: → champs structurés du brief.",
  },
  {
    marker: "Ad #N",
    chipClass: "bg-pf-soft text-pf-text border-pf-border",
    title: "Headers de hook",
    body: 'Ad #1 (Original) = V1. Ad #2 - Hook 2 / Ad #3 - Hook 3 = variantes.',
  },
];

// Plain-text version of the legend — what gets copied to the clipboard.
// Designed to render readably as-is in Google Docs / Notion / a plain text
// editor. Kept in sync with LEGEND_ITEMS but with examples so the user
// can paste it as a header in their own scripts doc.
const LEGEND_PLAINTEXT = `=== CONVENTIONS DU DOC PIXELFORGE ===

1. *  → Note perso
   Ligne totalement ignorée (ni VO, ni Notion).
   Ex: * à valider avec le client

2. >  → Note monteur
   Atterrit dans Filming notes Notion, par hook.
   Ex: > Couper silence après "patch"

3. EN MAJUSCULES → Setup vidéo / scène
   Ligne courte entièrement majuscule = indication de tournage.
   Strippée du VO, affichée dans Filming notes.
   Ex: HOMME DERMATO LUNETTE #1 :

4. Référence: / Avatars: → Métadonnées du brief
   Référence: <URL>            (créa concurrente à répliquer)
   Avatars: V1=2, H2=1, H3=0   (nb d'avatars par hook, 0 OK)

5. Ad #N → Headers de hook
   Ad Test #1 - <Créa>          (titre du brief, obligatoire)
   Ad #1 - <Créa> (Original)    (= V1, script complet)
   Ad #2 - <Créa> - Hook 2      (variante d'ouverture seule)
   Ad #3 - <Créa> - Hook 3      (variante d'ouverture seule)
`;

function Legend() {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(LEGEND_PLAINTEXT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers / restricted contexts.
      const ta = document.createElement("textarea");
      ta.value = LEGEND_PLAINTEXT;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        /* nothing else to do — clipboard refused */
      }
      document.body.removeChild(ta);
    }
  }, []);

  return (
    <div className="border-b border-pf-border bg-pf-bg/40 px-6 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wider text-pf-muted font-bold">
          Conventions du doc
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className={`inline-flex items-center gap-1.5 text-xs font-semibold rounded-md px-2.5 py-1 border transition-colors ${
            copied
              ? "bg-pf-ok/15 border-pf-ok/50 text-pf-ok"
              : "bg-pf-soft border-pf-border text-pf-dim hover:border-pf-accent hover:text-pf-text"
          }`}
          title="Copier la légende complète (à coller dans ton Google Doc / Notion)"
        >
          {copied ? (
            <>
              <Check size={12} className="pf-success-pop" />
              Copié
            </>
          ) : (
            <>
              <Copy size={12} />
              Copier la légende
            </>
          )}
        </button>
      </div>
      <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
        {LEGEND_ITEMS.map((it, i) => (
          <li
            key={i}
            className="flex items-start gap-2 bg-pf-elev border border-pf-border rounded-lg px-2.5 py-2 min-w-0"
          >
            <span className="text-[10px] font-mono font-bold text-pf-muted shrink-0 mt-0.5">
              {i + 1}.
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 mb-0.5">
                <code
                  className={`text-xs font-mono font-bold rounded px-1.5 py-0.5 border ${it.chipClass}`}
                >
                  {it.marker}
                </code>
                <span className="text-xs font-semibold text-pf-text truncate">
                  {it.title}
                </span>
              </div>
              <p className="text-[11px] text-pf-dim leading-snug">{it.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
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
