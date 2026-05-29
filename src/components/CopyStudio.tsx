"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";

import {
  BRAND_PRESETS,
  DEFAULT_BRAND,
  parseCopyOutput,
  type BrandKey,
  type CustomBrand,
} from "@/lib/copyBrands";

type ChatMessage = { role: "user" | "assistant"; content: string };

const STORAGE_KEY = "pf:copies:v1";
const HANDOFF_KEY = "pf:copyHandoff";

type Persisted = {
  brand: BrandKey;
  transcript: string;
  userNotes: string;
  custom: CustomBrand;
  conversation: ChatMessage[];
};

const DEFAULT_CUSTOM: CustomBrand = {
  name: "",
  productUrl: "",
  language: "fr",
  target: "",
  productDescription: "",
  socialProof: "",
  guarantee: "",
  tone: "",
};

function loadPersisted(): Partial<Persisted> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return (JSON.parse(raw) as Partial<Persisted>) ?? {};
  } catch {
    return {};
  }
}

export function CopyStudio() {
  // Hydrate synchronously to avoid an empty-flash first frame.
  const initial = typeof window !== "undefined" ? loadPersisted() : {};

  const [brand, setBrand] = useState<BrandKey>(initial.brand ?? DEFAULT_BRAND);
  const [transcript, setTranscript] = useState<string>(initial.transcript ?? "");
  const [userNotes, setUserNotes] = useState<string>(initial.userNotes ?? "");
  const [custom, setCustom] = useState<CustomBrand>(initial.custom ?? DEFAULT_CUSTOM);
  const [conversation, setConversation] = useState<ChatMessage[]>(
    initial.conversation ?? [],
  );
  const [iterInput, setIterInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const iterRef = useRef<HTMLTextAreaElement | null>(null);

  // Drain the handoff slot from /transcribe.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.sessionStorage.getItem(HANDOFF_KEY);
      if (!raw) return;
      window.sessionStorage.removeItem(HANDOFF_KEY);
      const payload = JSON.parse(raw) as { transcript?: string };
      if (typeof payload.transcript === "string" && payload.transcript.trim()) {
        setTranscript(payload.transcript.trim());
        // Drop any stale prior conversation — new transcript = new session.
        setConversation([]);
        setError(null);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Persist.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const payload: Persisted = { brand, transcript, userNotes, custom, conversation };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* quota */
    }
  }, [brand, transcript, userNotes, custom, conversation]);

  // The most recent assistant message — used for "regenerate" base state.
  const latestAssistant = useMemo(() => {
    for (let i = conversation.length - 1; i >= 0; i--) {
      if (conversation[i].role === "assistant") return conversation[i];
    }
    return null;
  }, [conversation]);

  // Merge copies + titles across the whole conversation so a "titles-only"
  // follow-up doesn't wipe out the existing copies. We walk from newest to
  // oldest and keep the first non-empty value for each slot.
  const parsed = useMemo(() => {
    const merged: { copies: string[]; titles: string[]; raw: string } = {
      copies: [],
      titles: [],
      raw: latestAssistant?.content ?? "",
    };
    const seen = { copy: new Set<number>(), title: new Set<number>() };
    for (let i = conversation.length - 1; i >= 0; i--) {
      const m = conversation[i];
      if (m.role !== "assistant") continue;
      const p = parseCopyOutput(m.content);
      p.copies.forEach((c, idx) => {
        if (!seen.copy.has(idx)) {
          merged.copies[idx] = c;
          seen.copy.add(idx);
        }
      });
      p.titles.forEach((t, idx) => {
        if (!seen.title.has(idx)) {
          merged.titles[idx] = t;
          seen.title.add(idx);
        }
      });
      if (seen.copy.size >= 3 && seen.title.size >= 3) break;
    }
    merged.copies = merged.copies.filter(Boolean);
    merged.titles = merged.titles.filter(Boolean);
    return merged;
  }, [conversation, latestAssistant]);

  const callApi = useCallback(
    async (followUp?: ChatMessage[]) => {
      setBusy(true);
      setError(null);
      try {
        const r = await fetch("/api/copy-generator", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brand,
            custom: brand === "custom" ? custom : undefined,
            transcript: transcript.trim(),
            userNotes: userNotes.trim() || undefined,
            conversation: followUp ?? [],
          }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
        const reply: ChatMessage = {
          role: "assistant",
          content: String(data?.content || "").trim(),
        };
        return reply;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [brand, custom, transcript, userNotes],
  );

  const handleGenerate = useCallback(async () => {
    if (!transcript.trim() || busy) return;
    // Fresh generation: drop any prior iteration history.
    const reply = await callApi([]);
    if (reply) {
      setConversation([reply]);
    }
  }, [busy, callApi, transcript]);

  const handleIterate = useCallback(async () => {
    const text = iterInput.trim();
    if (!text || busy || !latestAssistant) return;
    const userMsg: ChatMessage = { role: "user", content: text };
    const nextHist = [...conversation, userMsg];
    setConversation(nextHist);
    setIterInput("");
    const reply = await callApi(nextHist);
    if (reply) {
      setConversation((prev) => [...prev, reply]);
    } else {
      // Rollback the user msg on failure.
      setConversation((prev) => prev.slice(0, -1));
    }
    requestAnimationFrame(() => iterRef.current?.focus());
  }, [busy, callApi, conversation, iterInput, latestAssistant]);

  // Fallback when Claude's previous turn emitted copies but skipped (or
  // truncated) the title block. Sends a targeted follow-up that asks ONLY
  // for the 3 titles, keyed off the existing copies so they stay coherent.
  const handleGenerateTitlesOnly = useCallback(async () => {
    if (busy || !latestAssistant) return;
    const userMsg: ChatMessage = {
      role: "user",
      content:
        "Tu as oublié les 3 titres. Émets uniquement ===TITLE 1===, ===TITLE 2===, ===TITLE 3=== correspondant aux 3 copies que tu viens de produire, sur 3 drivers émotionnels distincts. Ne ré-émet PAS les copies. Format strict.",
    };
    const nextHist = [...conversation, userMsg];
    setConversation(nextHist);
    const reply = await callApi(nextHist);
    if (reply) {
      setConversation((prev) => [...prev, reply]);
    } else {
      setConversation((prev) => prev.slice(0, -1));
    }
  }, [busy, callApi, conversation, latestAssistant]);

  const handleCopy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1500);
    } catch {
      /* clipboard best-effort */
    }
  }, []);

  const handleReset = useCallback(() => {
    if (!conversation.length && !transcript.trim()) return;
    if (!window.confirm("Vider la session (transcript + résultats) ?")) return;
    setTranscript("");
    setUserNotes("");
    setConversation([]);
    setError(null);
  }, [conversation.length, transcript]);

  const activePreset = BRAND_PRESETS.find((p) => p.key === brand);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
      {/* MAIN */}
      <section className="space-y-5">
        {/* Brand selector */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted mb-2">
            Marque
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {BRAND_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setBrand(p.key)}
                className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${
                  brand === p.key
                    ? "border-pf-accent bg-pf-elev"
                    : "border-pf-border bg-pf-elev/60 hover:border-pf-dim"
                }`}
              >
                <div className="text-sm font-semibold flex items-center gap-2">
                  {p.label}
                  <span className="text-[9px] font-mono uppercase tracking-wider text-pf-muted">
                    {p.language}
                  </span>
                </div>
                <div className="text-[11px] text-pf-muted mt-0.5 leading-snug line-clamp-2">
                  {p.description}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Custom brand form */}
        {brand === "custom" ? (
          <CustomBrandForm value={custom} onChange={setCustom} />
        ) : null}

        {/* Script input */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted">
              Script vidéo / voix off
            </div>
            <span className="text-[10px] text-pf-muted">
              {transcript.length} chars
            </span>
          </div>
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder="Colle ici le script vidéo ou utilise Transcribe → 'Run ad copy + title' pour pré-remplir automatiquement."
            rows={9}
            className="w-full bg-pf-soft border border-pf-border rounded-lg px-3 py-2.5 text-sm placeholder:text-pf-muted resize-y focus:outline-none focus:border-pf-accent"
          />
        </div>

        {/* Optional notes */}
        <details className="bg-pf-elev/60 border border-pf-border rounded-lg">
          <summary className="cursor-pointer px-3 py-2 text-xs text-pf-dim hover:text-pf-text">
            Notes optionnelles (offre du moment, code promo, contrainte particulière…)
          </summary>
          <textarea
            value={userNotes}
            onChange={(e) => setUserNotes(e.target.value)}
            placeholder='Ex: "Code JETESTE 15%", "Insister sur la garantie 90j", "1 seule ✅ par copy"…'
            rows={3}
            className="w-full bg-transparent border-0 border-t border-pf-border rounded-b-lg px-3 py-2 text-xs placeholder:text-pf-muted focus:outline-none resize-y"
          />
        </details>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!transcript.trim() || busy}
            className="bg-pf-accent text-pf-accent-fg font-semibold rounded-lg px-5 py-3 text-sm flex items-center gap-2 disabled:opacity-40"
          >
            {busy && conversation.length <= 1 ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Wand2 size={14} />
            )}
            {conversation.length > 0 ? "Regenerate from scratch" : "Generate 3 copies + 3 titles"}
          </button>
          {conversation.length > 0 ? (
            <button
              type="button"
              onClick={handleReset}
              className="text-xs text-pf-muted hover:text-pf-danger flex items-center gap-1.5"
            >
              <Trash2 size={12} />
              Clear session
            </button>
          ) : null}
        </div>

        {error ? (
          <div className="bg-pf-elev border border-pf-danger/40 rounded-md px-4 py-3 text-sm text-pf-danger">
            ⚠ {error}
          </div>
        ) : null}

        {/* Result cards */}
        {parsed.copies.length > 0 || parsed.titles.length > 0 ? (
          <div className="space-y-5">
            <ResultColumn
              title="Titres Meta"
              kind="title"
              items={parsed.titles}
              copiedKey={copiedKey}
              onCopy={handleCopy}
            />

            {/* Recovery: if Claude shipped copies but no titles, expose a
                one-click follow-up that only asks for the missing titles. */}
            {parsed.titles.length === 0 && parsed.copies.length > 0 ? (
              <div className="bg-pf-elev border border-pf-warn/40 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
                <span className="text-xs text-pf-dim">
                  Claude n&apos;a pas émis les 3 titres. Tu peux les générer en un click.
                </span>
                <button
                  type="button"
                  onClick={handleGenerateTitlesOnly}
                  disabled={busy}
                  className="text-xs font-semibold bg-pf-accent text-pf-accent-fg rounded-md px-3 py-1.5 hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5"
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                  Générer les 3 titres
                </button>
              </div>
            ) : null}

            <ResultColumn
              title="Ad Copies"
              kind="copy"
              items={parsed.copies}
              copiedKey={copiedKey}
              onCopy={handleCopy}
            />
          </div>
        ) : busy ? (
          <div className="bg-pf-elev border border-pf-border rounded-xl px-4 py-10 text-center text-xs text-pf-muted">
            <Loader2 size={16} className="animate-spin inline-block mr-2 align-middle" />
            Claude rédige tes 3 copies + 3 titres…
          </div>
        ) : null}

        {/* Iteration chat */}
        {parsed.copies.length > 0 ? (
          <div className="bg-pf-elev border border-pf-border rounded-xl p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted mb-2 flex items-center gap-2">
              <RefreshCw size={11} />
              Itérer sur ces résultats
            </div>
            <div className="flex items-end gap-2">
              <textarea
                ref={iterRef}
                value={iterInput}
                onChange={(e) => setIterInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleIterate();
                  }
                }}
                placeholder='Ex: "plus court", "diversifie les hooks", "ajoute le code JETESTE 15%", "en anglais US"…'
                rows={2}
                className="flex-1 bg-pf-soft border border-pf-border rounded-md px-3 py-2 text-sm placeholder:text-pf-muted resize-y min-h-[56px] focus:outline-none focus:border-pf-accent"
              />
              <button
                type="button"
                onClick={handleIterate}
                disabled={!iterInput.trim() || busy}
                className="bg-pf-accent text-pf-accent-fg font-semibold rounded-md px-4 py-2 h-[56px] text-sm flex items-center gap-1.5 disabled:opacity-40"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              </button>
            </div>
            <div className="mt-2 text-[11px] text-pf-muted">
              ⌘/Ctrl + Enter pour envoyer · {conversation.length} tour(s) dans la session
            </div>
          </div>
        ) : null}
      </section>

      {/* SIDEBAR */}
      <aside className="bg-pf-elev border border-pf-border rounded-xl p-5 h-fit lg:sticky lg:top-20">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-7 h-7 rounded-md bg-pf-accent flex items-center justify-center text-pf-accent-fg">
            <Sparkles size={14} />
          </div>
          <div className="text-sm font-semibold">{activePreset?.label}</div>
        </div>
        <p className="text-xs text-pf-dim leading-relaxed mb-4">
          {activePreset?.description}
        </p>

        <div className="text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted mb-2">
          Comment ça marche
        </div>
        <ul className="text-xs text-pf-dim space-y-1.5 leading-relaxed mb-5">
          <li>1. Colle ton script (ou viens de Transcribe).</li>
          <li>2. Choisis la marque — les patterns A/B prod sont déjà codés.</li>
          <li>3. Generate → 3 copies + 3 titres, angles forcément différents.</li>
          <li>4. Itère en chat : « plus court », « diversifie », « code promo »…</li>
        </ul>

        <div className="text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted mb-2">
          Coût
        </div>
        <p className="text-xs text-pf-dim leading-relaxed">
          ~$0.01 par génération (Claude Sonnet, texte uniquement). Le transcript
          est resté chez toi, aucun upload de vidéo.
        </p>
      </aside>
    </div>
  );
}

function ResultColumn({
  title,
  kind,
  items,
  copiedKey,
  onCopy,
}: {
  title: string;
  kind: "copy" | "title";
  items: string[];
  copiedKey: string | null;
  onCopy: (key: string, text: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-pf-muted">
          {title}
        </h3>
        <span className="text-[10px] text-pf-muted">{items.length}</span>
      </div>
      <div className={`grid grid-cols-1 gap-3 ${kind === "title" ? "sm:grid-cols-3" : ""}`}>
        {items.map((text, i) => {
          const key = `${kind}-${i}`;
          const copied = copiedKey === key;
          return (
            <div
              key={key}
              className="bg-pf-bg border border-pf-border rounded-lg overflow-hidden"
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-pf-border">
                <span className="text-[10px] uppercase tracking-wider text-pf-muted font-semibold">
                  {kind === "copy" ? `Copy #${i + 1}` : `Titre #${i + 1}`}
                </span>
                <button
                  type="button"
                  onClick={() => onCopy(key, text)}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-pf-dim hover:text-pf-accent hover:bg-pf-soft"
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied ? "Copié" : "Copy"}
                </button>
              </div>
              <pre
                className={`p-4 text-pf-text whitespace-pre-wrap break-words font-mono leading-relaxed ${
                  kind === "title" ? "text-sm font-semibold" : "text-xs"
                }`}
              >
                {text}
              </pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CustomBrandForm({
  value,
  onChange,
}: {
  value: CustomBrand;
  onChange: (next: CustomBrand) => void;
}) {
  const upd = (patch: Partial<CustomBrand>) => onChange({ ...value, ...patch });
  return (
    <div className="bg-pf-elev/60 border border-pf-border rounded-lg p-4 space-y-3">
      <div className="text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted">
        Custom brand
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Nom de la marque" value={value.name} onChange={(v) => upd({ name: v })} />
        <Field
          label="URL produit"
          value={value.productUrl}
          onChange={(v) => upd({ productUrl: v })}
          placeholder="https://…"
        />
        <Field
          label="Cible"
          value={value.target}
          onChange={(v) => upd({ target: v })}
          placeholder="Ex: femmes 45-60 peau sèche"
        />
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted mb-1">
            Langue
          </label>
          <select
            value={value.language}
            onChange={(e) => upd({ language: e.target.value as "fr" | "en-us" })}
            className="w-full bg-pf-soft border border-pf-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-pf-accent"
          >
            <option value="fr">Français</option>
            <option value="en-us">US English</option>
          </select>
        </div>
      </div>
      <Field
        label="Produit (1-3 phrases)"
        value={value.productDescription}
        onChange={(v) => upd({ productDescription: v })}
        multiline
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field
          label="Social proof"
          value={value.socialProof ?? ""}
          onChange={(v) => upd({ socialProof: v })}
          placeholder="Ex: +12 600 satisfaits"
        />
        <Field
          label="Garantie"
          value={value.guarantee ?? ""}
          onChange={(v) => upd({ guarantee: v })}
          placeholder="Ex: remboursé 90j"
        />
      </div>
      <Field
        label="Ton / contraintes (optionnel)"
        value={value.tone ?? ""}
        onChange={(v) => upd({ tone: v })}
        placeholder='Ex: "ton chaleureux Top Santé", "pas plus de 3 bullets", "toujours finir par CTA chez vendeur"'
        multiline
      />
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted mb-1">
        {label}
      </label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={2}
          className="w-full bg-pf-soft border border-pf-border rounded-md px-3 py-2 text-sm placeholder:text-pf-muted focus:outline-none focus:border-pf-accent resize-y"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-pf-soft border border-pf-border rounded-md px-3 py-2 text-sm placeholder:text-pf-muted focus:outline-none focus:border-pf-accent"
        />
      )}
    </div>
  );
}
