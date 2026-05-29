"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  Loader2,
  Mic,
  Paperclip,
  Play,
  RefreshCw,
  Scissors,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";

import {
  type AttachTarget,
  applyAttach,
  clearAttachTarget,
  getAttachTarget,
  loadBrief,
  setAttachTarget,
} from "@/lib/briefs";
import { AttachToBriefButton } from "@/components/AttachToBriefButton";

type Voice = {
  voiceId: string;
  name: string;
  category?: string;
  description?: string;
  labels?: Record<string, string>;
  previewUrl?: string;
};

type Subscription = {
  tier?: string;
  characterCount: number;
  characterLimit: number;
  charactersRemaining: number;
  nextResetUnix?: number;
} | null;

type StoredVo = {
  id: string;
  url: string;
  voiceId: string;
  voiceName: string;
  modelId: string;
  text: string;
  charCount: number;
  at: number;
  // Two takes are generated per Generate click; batchId groups them so
  // the UI can show 'Take 1 / 2 — Choisis ta version'.
  batchId?: string;
  take?: number;
  takeTotal?: number;
};

const STORAGE_KEY = "pf:voiceover:v1";

const MODELS = [
  // V3 désactivé pour l'instant — l'API ElevenLabs renvoie HTTP 400
  // 'unsupported_model' quand on combine V3 + previous_text/next_text
  // (qu'on utilise pour le chunking parallèle des longs scripts).
  {
    id: "eleven_multilingual_v2",
    label: "Multilingual v2",
    note: "Recommandé. FR + EN, auto-chunké, prosodie continue.",
  },
  {
    id: "eleven_turbo_v2_5",
    label: "Turbo v2.5",
    note: "Plus rapide, qualité ~égale. Drafts.",
  },
  {
    id: "eleven_flash_v2_5",
    label: "Flash v2.5",
    note: "Ultra rapide, tests.",
  },
];

// User's daily-driver voice IDs from ElevenLabs. Order = priority. The first
// available one is auto-selected on a fresh session.
const FAVORITE_VOICE_IDS = [
  "T4x5CtnhOiichhcqFzgg",
  "G0yjIg3xY8gEJZkHpjVm",
] as const;

type Persisted = {
  voiceId: string;
  modelId: string;
  text: string;
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
  history: StoredVo[];
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

function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function VoiceoverStudio() {
  const router = useRouter();
  const initial = typeof window !== "undefined" ? loadPersisted() : {};

  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [voicesLoading, setVoicesLoading] = useState(true);
  const [subscription, setSubscription] = useState<Subscription>(null);

  const [voiceId, setVoiceId] = useState<string>(initial.voiceId ?? "");
  // Multilingual v2 by default — it supports the prosody-continuity fields
  // we use for chunked long-script generation. V3 is disabled until
  // ElevenLabs supports those fields on it.
  const [modelId, setModelId] = useState<string>(() => {
    const wanted = initial.modelId;
    // Migrate any persisted V3 selection back to V2 so users don't get
    // stuck on a model the server now refuses.
    if (!wanted || wanted.startsWith("eleven_v3")) return "eleven_multilingual_v2";
    return wanted;
  });
  const [text, setText] = useState<string>(initial.text ?? "");
  const [stability, setStability] = useState<number>(initial.stability ?? 0.6);
  const [similarityBoost, setSimilarityBoost] = useState<number>(initial.similarityBoost ?? 0.75);
  const [style, setStyle] = useState<number>(initial.style ?? 0);
  const [useSpeakerBoost, setUseSpeakerBoost] = useState<boolean>(initial.useSpeakerBoost ?? true);

  const [history, setHistory] = useState<StoredVo[]>(initial.history ?? []);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Brief attach intent — set by /briefs/[id] before navigating here.
  const [attachTarget, setAttachTargetState] = useState<AttachTarget | null>(null);
  const [attachBriefTitle, setAttachBriefTitle] = useState<string | null>(null);
  useEffect(() => {
    const t = getAttachTarget();
    if (t && (t.kind === "mainVo" || t.kind === "avatarClip")) {
      const b = loadBrief(t.briefId);
      if (b) {
        const h = b.hooks.find((x) => x.id === t.hookId);
        setAttachTargetState(t);
        setAttachBriefTitle(`${b.adsetName}${h ? ` — Hook ${h.index}` : ""}`);
      } else {
        clearAttachTarget();
      }
    }
  }, []);

  // Drain handoff from /prompts or /copies: a script that lands here ready
  // to be voiced. Lifecycle: sessionStorage 'pf:voHandoff' → fills the
  // textarea once and clears itself.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.sessionStorage.getItem("pf:voHandoff");
      if (!raw) return;
      window.sessionStorage.removeItem("pf:voHandoff");
      const payload = JSON.parse(raw) as { text?: string };
      if (typeof payload.text === "string" && payload.text.trim()) {
        setText(payload.text.trim());
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Persist UI state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const payload: Persisted = {
        voiceId,
        modelId,
        text,
        stability,
        similarityBoost,
        style,
        useSpeakerBoost,
        history,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* quota */
    }
  }, [voiceId, modelId, text, stability, similarityBoost, style, useSpeakerBoost, history]);

  // Load voices on mount.
  const loadVoices = useCallback(async () => {
    setVoicesLoading(true);
    setVoicesError(null);
    try {
      const r = await fetch("/api/voiceover/voices", { cache: "no-store" });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      const list = Array.isArray(data.voices) ? (data.voices as Voice[]) : [];
      setVoices(list);
      setSubscription(data.subscription ?? null);
      // Auto-pick: prefer the user's favorites in priority order; fall back
      // to the first voice in the library otherwise.
      if (!voiceId) {
        const fav = FAVORITE_VOICE_IDS.find((id) => list.some((v) => v.voiceId === id));
        if (fav) setVoiceId(fav);
        else if (list[0]?.voiceId) setVoiceId(list[0].voiceId);
      }
    } catch (e) {
      setVoicesError(e instanceof Error ? e.message : String(e));
    } finally {
      setVoicesLoading(false);
    }
  }, [voiceId]);
  useEffect(() => {
    loadVoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedVoice = useMemo(() => voices.find((v) => v.voiceId === voiceId), [voices, voiceId]);
  // Group voices by category for a nicer dropdown, with a pinned
  // "favorites" group at the very top.
  const groupedVoices = useMemo(() => {
    const out: Record<string, Voice[]> = {};
    const favs: Voice[] = [];
    for (const id of FAVORITE_VOICE_IDS) {
      const v = voices.find((x) => x.voiceId === id);
      if (v) favs.push(v);
    }
    if (favs.length > 0) out["★ favorites"] = favs;
    for (const v of voices) {
      if (FAVORITE_VOICE_IDS.includes(v.voiceId as (typeof FAVORITE_VOICE_IDS)[number])) {
        continue;
      }
      const k = (v.category || "other").toLowerCase();
      if (!out[k]) out[k] = [];
      out[k].push(v);
    }
    return out;
  }, [voices]);

  const handlePreview = useCallback((v: Voice) => {
    if (!v.previewUrl) return;
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }
    const a = new Audio(v.previewUrl);
    previewAudioRef.current = a;
    a.play().catch(() => {});
  }, []);

  // Single TTS call. Returns the parsed entry or throws a Error message
  // already formatted for the UI.
  const fetchOneTake = useCallback(
    async (take: number, takeTotal: number, batchId: string): Promise<StoredVo> => {
      const r = await fetch("/api/voiceover/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voiceId,
          voiceName: selectedVoice?.name,
          text: text.trim(),
          modelId,
          stability,
          similarityBoost,
          style,
          useSpeakerBoost,
        }),
      });
      const raw = await r.text();
      let data: { error?: string; url?: string; id?: string; charCount?: number };
      try {
        data = JSON.parse(raw) as typeof data;
      } catch {
        if (r.status === 504 || raw.toLowerCase().includes("timeout")) {
          throw new Error(
            "Vercel a coupé la requête à 60s (Hobby). Un chunk a dépassé le budget — réduis la stabilité ou utilise Turbo.",
          );
        }
        throw new Error(
          `Réponse non-JSON (HTTP ${r.status}). Server a planté: ${raw.slice(0, 160)}`,
        );
      }
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      if (!data.id || !data.url) {
        throw new Error("Réponse OK mais sans id/url — upload Supabase échoué.");
      }
      return {
        id: data.id,
        url: data.url,
        voiceId,
        voiceName: selectedVoice?.name || "voice",
        modelId,
        text: text.trim(),
        charCount: data.charCount ?? text.length,
        at: Date.now(),
        batchId,
        take,
        takeTotal,
      };
    },
    [
      voiceId,
      selectedVoice,
      text,
      modelId,
      stability,
      similarityBoost,
      style,
      useSpeakerBoost,
    ],
  );

  // Fires TWO takes in parallel per click. ElevenLabs returns slightly
  // different prosody on each call (the stability parameter controls
  // how much variation), so the user gets a real A/B to choose from.
  const handleGenerate = useCallback(async () => {
    if (!voiceId || !text.trim() || generating) return;
    setError(null);
    setGenerating(true);

    const batchId = `bat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const TAKES = 2;

    try {
      const results = await Promise.allSettled(
        Array.from({ length: TAKES }).map((_, i) => fetchOneTake(i + 1, TAKES, batchId)),
      );

      const entries: StoredVo[] = [];
      const errors: string[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") entries.push(r.value);
        else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
      }

      if (entries.length === 0) {
        throw new Error(errors[0] || "Les deux générations ont échoué");
      }

      // Insert in order so Take 1 sits above Take 2 in the history.
      setHistory((prev) => [...entries, ...prev].slice(0, 25));

      if (entries.length < TAKES) {
        setError(
          `Take ${entries.length}/${TAKES} générée — ${errors.length} version a échoué: ${errors[0]}`,
        );
      }

      // Refresh credits in the background.
      void loadVoices();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }, [voiceId, text, generating, fetchOneTake, loadVoices]);

  const handleCutSilence = useCallback(
    (entry: StoredVo) => {
      try {
        window.sessionStorage.setItem(
          "pf:cutSilenceHandoff",
          JSON.stringify({
            audioUrl: entry.url,
            fileName: `${entry.voiceName}_${entry.id}.mp3`,
            ts: Date.now(),
          }),
        );
      } catch {
        /* quota */
      }
      // Promote a 'mainVo' brief target to 'cutVo' so the cleaned WAV
      // lands in the brief's final voice-off slot, not back in the raw
      // slot. avatarClip / cutVo stay as they are. hookId is carried over.
      const t = getAttachTarget();
      if (t && t.kind === "mainVo") {
        setAttachTarget({ kind: "cutVo", briefId: t.briefId, hookId: t.hookId });
      }
      router.push("/cut-silence");
    },
    [router],
  );

  // Direct Attach handler (skip Cut Silence). When the user picks Attach
  // on a VO card, we treat their take as already-final — for the
  // 'mainVo' target this means writing the raw URL straight to the
  // brief's cutVoUrl slot so the brief's VO step immediately shows
  // '✓ Voix off finalisée'. avatarClip targets still go to the avatar's
  // voClipUrl as before.
  const handleAttachToBrief = useCallback(
    (entry: StoredVo) => {
      if (!attachTarget) return;
      const target: AttachTarget =
        attachTarget.kind === "mainVo"
          ? { kind: "cutVo", briefId: attachTarget.briefId, hookId: attachTarget.hookId }
          : attachTarget;
      const updated = applyAttach(target, {
        url: entry.url,
        voiceName: entry.voiceName,
        text: entry.text,
      });
      if (!updated) {
        setError("Le brief cible est introuvable.");
        return;
      }
      clearAttachTarget();
      router.push(`/briefs/${target.briefId}`);
    },
    [attachTarget, router],
  );

  const handleCopyUrl = useCallback(async (entry: StoredVo) => {
    try {
      await navigator.clipboard.writeText(entry.url);
      setCopied(entry.id);
      setTimeout(() => setCopied((c) => (c === entry.id ? null : c)), 1500);
    } catch {
      /* ignored */
    }
  }, []);

  const handleDelete = useCallback((entry: StoredVo) => {
    if (!window.confirm(`Retirer cette VO de l'historique ?`)) return;
    setHistory((prev) => prev.filter((h) => h.id !== entry.id));
  }, []);

  const handleClearAll = useCallback(() => {
    if (!history.length) return;
    if (!window.confirm("Vider tout l'historique local des VO ?")) return;
    setHistory([]);
  }, [history.length]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
      {/* MAIN */}
      <section className="space-y-5">
        {/* Brief attach banner */}
        {attachTarget && attachBriefTitle ? (
          <div className="bg-pf-elev border border-pf-accent/50 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs">
              <Paperclip size={13} className="text-pf-accent" />
              <span>
                Tu génères pour le brief{" "}
                <Link
                  href={`/briefs/${attachTarget.briefId}`}
                  className="font-semibold text-pf-accent"
                >
                  {attachBriefTitle}
                </Link>
                . <strong>Attach</strong> = directement final, <strong>Cut
                blanks</strong> = passer par Cut Silence d&apos;abord.
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setAttachTargetState(null);
              }}
              className="text-pf-muted hover:text-pf-text"
              title="Ne plus attacher à ce brief (le target est gardé pour Cut Silence)"
            >
              <ArrowLeft size={13} />
            </button>
          </div>
        ) : null}

        {/* Voice selector */}
        <div className="bg-pf-elev border border-pf-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted">
              Voix ElevenLabs
            </div>
            <button
              type="button"
              onClick={loadVoices}
              disabled={voicesLoading}
              className="text-[11px] text-pf-dim hover:text-pf-accent flex items-center gap-1 disabled:opacity-40"
            >
              <RefreshCw size={11} className={voicesLoading ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>

          {voicesError ? (
            <div className="bg-pf-bg border border-pf-danger/40 rounded-md px-3 py-2 text-xs text-pf-danger mb-3">
              ⚠ {voicesError}
              {voicesError.includes("ELEVENLABS_API_KEY") ? (
                <div className="mt-1.5 text-pf-muted">
                  Ajoute la clé dans Vercel → Settings → Environment Variables, puis Redeploy.
                </div>
              ) : null}
            </div>
          ) : null}

          {voicesLoading && voices.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-pf-muted">
              <Loader2 size={12} className="animate-spin" />
              Chargement de ta library…
            </div>
          ) : voices.length === 0 ? (
            <div className="text-xs text-pf-muted">
              Aucune voix trouvée. Vérifie ta clé ou ajoute des voix sur elevenlabs.io.
            </div>
          ) : (
            <div>
              <select
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
                className="w-full bg-pf-soft border border-pf-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-pf-accent"
              >
                {Object.entries(groupedVoices).map(([cat, list]) => (
                  <optgroup key={cat} label={cat.toUpperCase()}>
                    {list.map((v) => (
                      <option key={v.voiceId} value={v.voiceId}>
                        {v.name}
                        {v.labels?.gender ? ` — ${v.labels.gender}` : ""}
                        {v.labels?.accent ? ` · ${v.labels.accent}` : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>

              {selectedVoice ? (
                <div className="flex items-center gap-2 mt-2.5">
                  {selectedVoice.previewUrl ? (
                    <button
                      type="button"
                      onClick={() => handlePreview(selectedVoice)}
                      className="flex items-center gap-1 text-[11px] text-pf-dim hover:text-pf-accent border border-pf-border rounded-md px-2 py-1"
                    >
                      <Play size={11} />
                      Preview
                    </button>
                  ) : null}
                  {selectedVoice.description ? (
                    <div className="text-[11px] text-pf-muted leading-snug line-clamp-2 flex-1">
                      {selectedVoice.description}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Script */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted">
              Script à voicer
            </div>
            <span className="text-[10px] text-pf-muted">
              {text.length} chars
              {subscription
                ? ` · ${fmt(subscription.charactersRemaining)} restants`
                : ""}
            </span>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Colle le script à voicer. Ponctuation et retours à la ligne = pauses naturelles. Max 8000 chars par génération."
            rows={9}
            className="w-full bg-pf-soft border border-pf-border rounded-lg px-3 py-2.5 text-sm placeholder:text-pf-muted resize-y focus:outline-none focus:border-pf-accent"
          />
        </div>

        {/* Model + voice settings */}
        <div className="bg-pf-elev/60 border border-pf-border rounded-lg p-4 space-y-4">
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted mb-1.5">
              Modèle
            </label>
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="w-full bg-pf-soft border border-pf-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-pf-accent"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.note}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Slider
              label="Stabilité"
              value={stability}
              onChange={setStability}
              note="↓ + expressif · ↑ + monotone"
            />
            <Slider
              label="Similarité"
              value={similarityBoost}
              onChange={setSimilarityBoost}
              note="Fidélité au timbre original"
            />
            <Slider
              label="Style"
              value={style}
              onChange={setStyle}
              note="Intensité du style (0 = neutre)"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-pf-dim">
            <input
              type="checkbox"
              checked={useSpeakerBoost}
              onChange={(e) => setUseSpeakerBoost(e.target.checked)}
            />
            Speaker boost (renforce le timbre)
          </label>
        </div>

        {/* Generate button */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!voiceId || !text.trim() || generating}
            className="bg-pf-accent text-pf-accent-fg font-semibold rounded-lg px-5 py-3 text-sm flex items-center gap-2 disabled:opacity-40"
          >
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}
            {generating ? "Génération des 2 takes…" : "Generate 2 takes"}
          </button>
          <span className="text-[11px] text-pf-muted">
            2 versions en parallèle — tu choisis la meilleure.
          </span>
          {history.length > 0 ? (
            <span className="text-xs text-pf-muted">
              {history.length} dans l&apos;historique
            </span>
          ) : null}
        </div>

        {error ? (
          <div className="bg-pf-elev border border-pf-danger/40 rounded-md px-4 py-3 text-sm text-pf-danger">
            ⚠ {error}
          </div>
        ) : null}

        {/* History */}
        {history.length > 0 ? (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-pf-muted">
                Voiceovers générés
              </h3>
              <button
                type="button"
                onClick={handleClearAll}
                className="text-[11px] text-pf-muted hover:text-pf-danger flex items-center gap-1"
              >
                <Trash2 size={11} />
                Clear
              </button>
            </div>
            <div className="space-y-3">
              {history.map((entry) => (
                <VoCard
                  key={entry.id}
                  entry={entry}
                  copied={copied === entry.id}
                  attachLabel={
                    attachTarget && attachBriefTitle
                      ? `Attach → ${attachBriefTitle}`
                      : undefined
                  }
                  onAttach={attachTarget ? () => handleAttachToBrief(entry) : undefined}
                  // Both Attach (direct, skip cut) and Cut blanks are visible
                  // when a brief target is active — user chooses.
                  cutBlanksPrimary={!!attachTarget}
                  onCutSilence={() => handleCutSilence(entry)}
                  onCopyUrl={() => handleCopyUrl(entry)}
                  onDelete={() => handleDelete(entry)}
                />
              ))}
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
          <div className="text-sm font-semibold">Voiceover</div>
        </div>
        <p className="text-xs text-pf-dim leading-relaxed mb-4">
          Génère une VO depuis ta library ElevenLabs, stockée dans Supabase Storage,
          handoff direct vers Cut Silence ou Lipsync Studio.
        </p>

        {subscription ? (
          <div className="bg-pf-bg border border-pf-border rounded-md p-3 mb-4">
            <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted mb-1">
              Crédits ElevenLabs
            </div>
            <div className="text-sm font-mono">
              <span className="text-pf-accent font-semibold">
                {fmt(subscription.charactersRemaining)}
              </span>{" "}
              / {fmt(subscription.characterLimit)}
            </div>
            <div className="h-1 bg-pf-soft rounded-full mt-2 overflow-hidden">
              <div
                className="h-full bg-pf-accent"
                style={{
                  width: `${Math.min(100, Math.max(0, (subscription.charactersRemaining / Math.max(1, subscription.characterLimit)) * 100))}%`,
                }}
              />
            </div>
            {subscription.tier ? (
              <div className="text-[10px] text-pf-muted mt-1.5 uppercase tracking-wider">
                Plan {subscription.tier}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted mb-2">
          Pipeline
        </div>
        <ol className="text-xs text-pf-dim space-y-1.5 leading-relaxed mb-5">
          <li>1. Voix + script → Generate</li>
          <li>2. ⚡ Cut silences → Cut Silence Studio</li>
          <li>3. (à venir) Split par avatar</li>
          <li>4. Lipsync Studio avec l&apos;image qui matche</li>
        </ol>

        <div className="text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted mb-2">
          Conseils
        </div>
        <ul className="text-xs text-pf-dim space-y-1.5 leading-relaxed">
          <li>• Multilingual v2 par défaut, FR/EN naturel.</li>
          <li>• Stabilité 0.4-0.6 pour des ads UGC vivantes.</li>
          <li>• La ponctuation contrôle les pauses, plus que les paramètres.</li>
        </ul>
      </aside>
    </div>
  );
}

function Slider({
  label,
  value,
  onChange,
  note,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  note?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted">
          {label}
        </label>
        <span className="text-[11px] font-mono text-pf-dim">{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-pf-accent"
      />
      {note ? <div className="text-[10px] text-pf-muted mt-0.5 leading-snug">{note}</div> : null}
    </div>
  );
}

function VoCard({
  entry,
  copied,
  attachLabel,
  onAttach,
  cutBlanksPrimary,
  onCutSilence,
  onCopyUrl,
  onDelete,
}: {
  entry: StoredVo;
  copied: boolean;
  attachLabel?: string;
  onAttach?: () => void;
  cutBlanksPrimary?: boolean;
  onCutSilence: () => void;
  onCopyUrl: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="bg-pf-elev border border-pf-border rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-pf-border">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{entry.voiceName}</span>
            {entry.take && entry.takeTotal && entry.takeTotal > 1 ? (
              <span className="text-[9px] font-bold uppercase tracking-wider bg-pf-accent text-pf-accent-fg rounded px-1.5 py-0.5">
                Take {entry.take} / {entry.takeTotal}
              </span>
            ) : null}
          </div>
          <span className="text-[10px] text-pf-muted font-mono">
            {entry.modelId} · {entry.charCount} chars · {new Date(entry.at).toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCopyUrl}
            className="flex items-center gap-1 text-xs text-pf-dim hover:text-pf-accent border border-pf-border rounded-md px-2 py-1"
            title="Copier l'URL Supabase"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copié" : "URL"}
          </button>
          <a
            href={entry.url}
            download={`${entry.voiceName}_${entry.id}.mp3`}
            className="flex items-center gap-1 text-xs text-pf-dim hover:text-pf-accent border border-pf-border rounded-md px-2 py-1"
          >
            <Download size={12} />
            Download
          </a>
          {onAttach ? (
            <button
              type="button"
              onClick={onAttach}
              className="flex items-center gap-1 text-xs font-semibold bg-pf-accent text-pf-accent-fg rounded-md px-2.5 py-1 hover:opacity-90"
              title="Attacher cette VO au brief courant"
            >
              <Paperclip size={12} />
              {attachLabel || "Attach"}
            </button>
          ) : null}
          <AttachToBriefButton
            asset={{
              kind: "audio",
              url: entry.url,
              voiceName: entry.voiceName,
              text: entry.text,
              label: `cette voix off (${entry.voiceName})`,
            }}
            label={onAttach ? "Vers brief" : "Rattacher au brief"}
          />
          <button
            type="button"
            onClick={onCutSilence}
            className={`flex items-center gap-1 text-xs font-semibold rounded-md px-2.5 py-1 ${
              cutBlanksPrimary
                ? "bg-pf-accent text-pf-accent-fg hover:opacity-90"
                : "bg-pf-soft border border-pf-border text-pf-text hover:border-pf-accent"
            }`}
            title="Envoyer vers Cut Silence avec l'audio préchargé"
          >
            <Scissors size={12} />
            Cut blanks
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="flex items-center gap-1 text-pf-muted hover:text-pf-danger px-1.5 py-1"
            title="Retirer de l'historique"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <div className="px-4 py-3">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio controls src={entry.url} className="w-full" />
        <p className="mt-2 text-[11px] text-pf-muted leading-snug line-clamp-3">
          {entry.text}
        </p>
      </div>
    </div>
  );
}

// Suppress unused-import warnings — Wand2 reserved for a future "Send to
// Lipsync" button on each card. (Kept so the lucide tree-shake catches it.)
void Wand2;
