"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Plus, Sparkles, Trash2, Users, X } from "lucide-react";

import {
  type Brief,
  deleteBrief,
  loadBriefs,
  newBrief,
  upsertBrief,
} from "@/lib/briefs";

export function BriefsList() {
  const router = useRouter();
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [picker, setPicker] = useState(false);

  useEffect(() => {
    setBriefs(loadBriefs());
  }, []);

  const refresh = useCallback(() => setBriefs(loadBriefs()), []);

  const handleCreate = useCallback(
    (avatarCount: number) => {
      const b = newBrief({ avatarCount });
      upsertBrief(b);
      setPicker(false);
      router.push(`/briefs/${b.id}`);
    },
    [router],
  );

  const handleDelete = useCallback(
    (id: string) => {
      if (!window.confirm("Supprimer ce brief ?")) return;
      deleteBrief(id);
      refresh();
    },
    [refresh],
  );

  return (
    <div className="space-y-6">
      {/* Top hero — fast path = batch, single brief = secondary */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-3">
        <Link
          href="/briefs/batch"
          className="group relative overflow-hidden bg-gradient-to-br from-pf-accent/15 via-pf-accent/5 to-transparent border border-pf-accent/40 hover:border-pf-accent rounded-2xl p-5 transition-colors"
        >
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-pf-accent/15 border border-pf-accent/30 flex items-center justify-center text-pf-accent shrink-0">
              <Sparkles size={20} />
            </div>
            <div className="min-w-0">
              <div className="text-base font-bold mb-1">Préparer ma semaine</div>
              <p className="text-xs text-pf-dim leading-relaxed">
                Crée 10 briefs d&apos;un coup. Saisis tous les scripts. Génère
                les 30 voix off en parallèle. Push tout vers Notion.
              </p>
              <div className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-pf-accent">
                Lancer le batch →
              </div>
            </div>
          </div>
        </Link>

        <button
          type="button"
          onClick={() => setPicker(true)}
          className="text-left bg-pf-elev border border-pf-border hover:border-pf-accent rounded-2xl p-5 transition-colors"
        >
          <div className="w-10 h-10 rounded-lg bg-pf-soft border border-pf-border flex items-center justify-center text-pf-accent mb-3">
            <Plus size={18} />
          </div>
          <div className="text-sm font-semibold mb-1">Brief unique</div>
          <p className="text-xs text-pf-muted leading-snug">
            Pour ajuster un brief en détail. Wizard guidé.
          </p>
        </button>
      </div>

      {picker ? (
        <AvatarPicker onPick={handleCreate} onCancel={() => setPicker(false)} />
      ) : null}

      <div className="flex items-center justify-between pt-2">
        <h2 className="text-sm font-semibold text-pf-text">Mes briefs</h2>
        <span className="text-xs text-pf-muted">
          {briefs.length} brief{briefs.length > 1 ? "s" : ""} · 1 brief = autant de hooks que ton script
        </span>
      </div>

      {briefs.length === 0 ? (
        <div className="bg-pf-elev border border-pf-border rounded-xl p-10 text-center">
          <div className="w-12 h-12 mx-auto rounded-full bg-pf-soft border border-pf-border flex items-center justify-center text-pf-accent mb-3">
            <FileText size={20} />
          </div>
          <div className="text-sm font-semibold mb-1">Aucun brief encore</div>
          <p className="text-xs text-pf-muted max-w-sm mx-auto">
            Lance un batch pour préparer ta semaine, ou crée un brief unique
            pour démarrer. Par défaut 3 hooks (l&apos;import d&apos;un Google Doc détecte
            automatiquement le bon nombre, jusqu&apos;à 50).
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {briefs.map((b) => (
            <BriefCard key={b.id} brief={b} onDelete={() => handleDelete(b.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Avatar picker — single screen, no template choice. avatarCount = 0 means
// "no AI avatar at all" (the wizard's Avatars step is then auto-hidden).
// ---------------------------------------------------------------------------

function AvatarPicker({
  onPick,
  onCancel,
}: {
  onPick: (avatarCount: number) => void;
  onCancel: () => void;
}) {
  const [avatarCount, setAvatarCount] = useState(1);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center px-4">
      <div className="bg-pf-elev border border-pf-border rounded-2xl p-6 max-w-md w-full">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold">Combien d&apos;avatars IA ?</h2>
          <button
            type="button"
            onClick={onCancel}
            className="w-8 h-8 rounded-md hover:bg-pf-soft flex items-center justify-center text-pf-muted hover:text-pf-text transition-colors"
            aria-label="Fermer"
          >
            <X size={16} />
          </button>
        </div>

        <p className="text-xs text-pf-dim mb-5 leading-relaxed">
          Le nombre s&apos;applique à tous les hooks (3 par défaut). Choisis{" "}
          <span className="text-pf-text font-medium">0</span> si tu n&apos;utilises
          pas d&apos;avatar IA pour ce brief — l&apos;étape correspondante sera
          masquée.
        </p>

        {/* Visual scale 0..5 */}
        <div className="grid grid-cols-6 gap-2 mb-5">
          {[0, 1, 2, 3, 4, 5].map((n) => {
            const active = n === avatarCount;
            return (
              <button
                key={n}
                type="button"
                onClick={() => setAvatarCount(n)}
                className={`aspect-square rounded-xl border-2 flex flex-col items-center justify-center transition-all ${
                  active
                    ? "border-pf-accent bg-pf-accent/15 text-pf-accent"
                    : "border-pf-border bg-pf-bg hover:border-pf-accent/60 text-pf-text"
                }`}
              >
                <div className="text-xl font-bold leading-none">{n}</div>
                <div className="mt-1 text-[10px] text-pf-muted">
                  {n === 0 ? "aucun" : "av."}
                </div>
              </button>
            );
          })}
        </div>

        <div className="bg-pf-bg border border-pf-border rounded-lg p-3 mb-5 flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-md bg-pf-soft border border-pf-border flex items-center justify-center shrink-0 text-pf-accent">
            {avatarCount === 0 ? <FileText size={14} /> : <Users size={14} />}
          </div>
          <div className="text-xs text-pf-dim leading-relaxed">
            {avatarCount === 0 ? (
              <>
                <span className="text-pf-text font-medium">Sans avatar IA</span> —
                voix off + B-rolls uniquement. Wizard plus court.
              </>
            ) : (
              <>
                <span className="text-pf-text font-medium">
                  {avatarCount} avatar{avatarCount > 1 ? "s" : ""} par hook
                </span>{" "}
                — soit {avatarCount * 3} lipsyncs au total pour ce brief.
              </>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => onPick(avatarCount)}
          className="w-full bg-pf-accent text-pf-accent-fg font-semibold rounded-lg px-4 py-2.5 text-sm hover:bg-pf-accent/90 transition-colors"
        >
          Créer le brief
        </button>
      </div>
    </div>
  );
}

function BriefCard({ brief, onDelete }: { brief: Brief; onDelete: () => void }) {
  const hasAvatars = brief.avatarCount > 0;
  const Icon = hasAvatars ? Users : FileText;
  const progress = computeProgress(brief);
  return (
    <Link
      href={`/briefs/${brief.id}`}
      className="group block bg-pf-elev border border-pf-border hover:border-pf-accent rounded-xl p-4 transition-colors"
    >
      <div className="flex items-start justify-between mb-2">
        <div className="w-9 h-9 rounded-md bg-pf-soft border border-pf-border flex items-center justify-center text-pf-accent">
          <Icon size={16} />
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }}
          className="text-pf-muted hover:text-pf-danger opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="text-sm font-semibold truncate">{brief.adsetName}</div>
      <div className="text-[11px] text-pf-muted font-mono mt-0.5">
        {brief.hooks.length} hook{brief.hooks.length > 1 ? "s" : ""}
        {hasAvatars ? ` × ${brief.avatarCount} avatars` : ""} ·{" "}
        {new Date(brief.updatedAt).toLocaleDateString()}
      </div>
      <div className="mt-3 h-1 bg-pf-soft rounded-full overflow-hidden">
        <div
          className="h-full bg-pf-accent transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="text-[10px] text-pf-muted mt-1">{progress}% complété</div>
    </Link>
  );
}

function computeProgress(brief: Brief): number {
  const flags: boolean[] = [];
  flags.push(!!brief.baseScript.trim());
  for (const h of brief.hooks) {
    flags.push(!!h.hookScript.trim());
    flags.push(!!h.cutVoUrl);
    if (brief.avatarCount > 0) {
      for (const av of h.avatars) {
        flags.push(!!av.voClipUrl);
        flags.push(!!av.imageUrl);
        flags.push(av.lipsyncStatus === "done" && !!av.lipsyncVideoUrl);
      }
    }
  }
  if (flags.length === 0) return 0;
  const done = flags.filter(Boolean).length;
  return Math.round((done / flags.length) * 100);
}
