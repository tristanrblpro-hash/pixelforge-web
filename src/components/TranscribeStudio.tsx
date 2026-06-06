"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Copy,
  FileAudio,
  FileVideo,
  Loader2,
  Trash2,
  Upload as UploadIcon,
  Wand2,
} from "lucide-react";

/**
 * 100% in-browser, 100% free transcription using Whisper via Transformers.js.
 *
 * - The model (~75 MB for whisper-base) is downloaded once from Hugging Face
 *   and cached by the browser (IndexedDB). Future runs are instant.
 * - Inference runs locally on WebAssembly / WebGPU — no server, no API,
 *   no cost, the audio never leaves the user's machine.
 * - Both audio AND video files work: we decode the audio track in the
 *   browser via AudioContext.decodeAudioData, downsample to 16 kHz mono
 *   (what Whisper expects), then feed it to the pipeline.
 */

type Stage =
  | "idle"
  | "loading-model"
  | "decoding-audio"
  | "transcribing"
  | "done"
  | "error";

type ModelOption = {
  id: string; // HF repo id
  label: string;
  size: string;
  notes: string;
};

const MODELS: ModelOption[] = [
  {
    id: "Xenova/whisper-base",
    label: "Whisper Base",
    size: "~75 MB",
    notes: "Bon équilibre qualité/poids · multilingue (FR + EN).",
  },
  {
    id: "Xenova/whisper-tiny",
    label: "Whisper Tiny",
    size: "~40 MB",
    notes: "Le plus rapide · qualité moindre · multilingue.",
  },
  {
    id: "Xenova/whisper-small",
    label: "Whisper Small",
    size: "~245 MB",
    notes: "Meilleure qualité · plus long à charger.",
  },
];

const LANG_OPTIONS = [
  { value: "auto", label: "Auto-détection" },
  { value: "french", label: "Français" },
  { value: "english", label: "English" },
  { value: "spanish", label: "Español" },
  { value: "italian", label: "Italiano" },
  { value: "german", label: "Deutsch" },
];

const STORAGE_KEY = "pf:transcribe:v2";

type StoredTranscript = {
  text: string;
  modelId: string;
  fileName: string;
  mime: string;
  at: number;
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Decode an audio or video file → Float32Array @ 16 kHz mono.
async function decodeFileToPcm(file: File): Promise<Float32Array> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx =
    (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
  // Target 16 kHz — Whisper's native sample rate. Browsers will resample on
  // decode if possible. Safari sometimes ignores it, in which case we
  // downsample manually below.
  const ctx = new AudioCtx({ sampleRate: 16000 });
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch (e) {
    await ctx.close();
    throw new Error(
      "Impossible de décoder le fichier. Pour les vidéos : utilise MP4 (AAC) ou WebM. " +
        "Pour l'audio : MP3, WAV, M4A, OGG. " +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }

  // Mix down to mono.
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < channels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
  }
  await ctx.close();

  // Downsample if browser ignored our 16 kHz hint.
  if (audioBuffer.sampleRate !== 16000) {
    const ratio = audioBuffer.sampleRate / 16000;
    const outLen = Math.floor(mono.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = Math.floor(i * ratio);
      out[i] = mono[idx];
    }
    return out;
  }
  return mono;
}

export function TranscribeStudio() {
  const router = useRouter();
  const [modelId, setModelId] = useState(MODELS[0].id);
  const [language, setLanguage] = useState("auto");
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [history, setHistory] = useState<StoredTranscript[]>([]);
  const [modelProgress, setModelProgress] = useState<{ file: string; pct: number } | null>(null);
  const [audioDurationSec, setAudioDurationSec] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Cache the pipeline keyed by model id so swapping models reloads, same
  // model stays warm. The pipe value comes from a dynamically-typed lib so
  // we keep it as `any` here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pipelineRef = useRef<{ id: string; pipe: any } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { history?: StoredTranscript[] };
      if (Array.isArray(parsed.history)) {
        setHistory(parsed.history.slice(0, 10));
      }
    } catch {
      /* ignored */
    }
  }, []);

  const persistHistory = useCallback((next: StoredTranscript[]) => {
    setHistory(next);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ history: next }));
    } catch {
      /* quota */
    }
  }, []);

  const handlePick = useCallback((f: File | null) => {
    if (!f) return;
    setFile(f);
    setError(null);
    setTranscript("");
    setStage("idle");
    setAudioDurationSec(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) handlePick(f);
    },
    [handlePick],
  );

  const handleRun = useCallback(async () => {
    if (!file) return;
    setError(null);
    setTranscript("");

    try {
      // 1. Load the Transformers.js pipeline (lazy dynamic import so it stays
      //    out of the main JS bundle). We cast to `any` because the lib's
      //    types depend on the model class, which we don't know at compile
      //    time, and the pipeline returns a callable union that TS can't
      //    narrow ergonomically.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let pipe: any = pipelineRef.current?.id === modelId ? pipelineRef.current.pipe : null;
      if (!pipe) {
        setStage("loading-model");
        setModelProgress({ file: "init", pct: 0 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tx: any = await import("@huggingface/transformers");
        tx.env.allowLocalModels = false;
        tx.env.useBrowserCache = true;
        pipe = await tx.pipeline("automatic-speech-recognition", modelId, {
          progress_callback: (p: { status: string; file?: string; progress?: number }) => {
            if (p.status === "progress" && typeof p.progress === "number") {
              setModelProgress({ file: p.file || "model", pct: Math.round(p.progress) });
            } else if (p.status === "done") {
              setModelProgress({ file: p.file || "model", pct: 100 });
            }
          },
        });
        pipelineRef.current = { id: modelId, pipe };
      }

      // 2. Decode the file → PCM.
      setStage("decoding-audio");
      const pcm = await decodeFileToPcm(file);
      setAudioDurationSec(pcm.length / 16000);

      // 3. Inference.
      setStage("transcribing");
      const out = await pipe(pcm, {
        chunk_length_s: 30,
        stride_length_s: 5,
        language: language === "auto" ? undefined : language,
        task: "transcribe",
        return_timestamps: false,
      });

      const text = Array.isArray(out)
        ? out.map((o: { text?: string }) => o.text || "").join(" ").trim()
        : ((out as { text?: string })?.text || "").trim();

      if (!text) throw new Error("Transcription vide");

      setTranscript(text);
      setStage("done");

      const entry: StoredTranscript = {
        text,
        modelId,
        fileName: file.name,
        mime: file.type,
        at: Date.now(),
      };
      persistHistory([entry, ...history].slice(0, 10));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStage("error");
    }
  }, [file, history, language, modelId, persistHistory]);

  const handleCopy = useCallback(async () => {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignored */
    }
  }, [transcript]);

  // Hand the current transcript off to the Ad Copies tool and jump there.
  // CopyStudio drains sessionStorage on mount and pre-fills its script field.
  const handleRunCopies = useCallback(() => {
    if (!transcript) return;
    try {
      window.sessionStorage.setItem(
        "pf:copyHandoff",
        JSON.stringify({ transcript, ts: Date.now() }),
      );
    } catch {
      /* quota */
    }
    router.push("/copies");
  }, [router, transcript]);

  const handleClearHistory = useCallback(() => {
    if (!history.length) return;
    if (!window.confirm("Effacer l'historique des transcriptions ?")) return;
    persistHistory([]);
  }, [history.length, persistHistory]);

  const FileIcon = file ? (file.type.startsWith("video/") ? FileVideo : FileAudio) : UploadIcon;
  const isWorking =
    stage === "loading-model" || stage === "decoding-audio" || stage === "transcribing";

  const stageLabel: Record<Stage, string> = {
    idle: "Transcribe",
    "loading-model":
      modelProgress && modelProgress.pct < 100
        ? `Téléchargement du modèle ${modelProgress.pct}%`
        : "Chargement du modèle…",
    "decoding-audio": "Décodage audio…",
    transcribing: "Transcription…",
    done: "Transcribe",
    error: "Transcribe",
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
      {/* Main column */}
      <section className="space-y-5">
        {/* YouTube quick transcript — extracts native captions, no local
            ML pipeline needed. Self-contained: own state + result block. */}
        <YoutubeBlock />

        {/* Drop zone */}
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed py-12 px-6 cursor-pointer transition-colors ${
            dragOver
              ? "border-pf-accent bg-pf-elev"
              : "border-pf-border bg-pf-elev/60 hover:border-pf-dim"
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept="audio/*,video/*"
            className="hidden"
            onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
          />
          <div className="w-12 h-12 rounded-full bg-pf-soft border border-pf-border flex items-center justify-center text-pf-accent">
            <FileIcon size={20} />
          </div>
          {file ? (
            <div className="text-center">
              <div className="text-sm font-semibold">{file.name}</div>
              <div className="text-xs text-pf-muted mt-0.5">
                {file.type || "unknown"} · {fmtBytes(file.size)}
                {audioDurationSec ? ` · ${Math.round(audioDurationSec)}s` : ""}
              </div>
            </div>
          ) : (
            <div className="text-center">
              <div className="text-sm font-semibold">
                Glisse un fichier audio ou vidéo
              </div>
              <div className="text-xs text-pf-muted mt-1">
                MP3, WAV, M4A, OGG, WebM ou MP4, MOV, WebM · jusqu&apos;à ~200 MB
              </div>
              <div className="text-[11px] text-pf-muted mt-2">
                100% local, gratuit, aucun upload — Whisper tourne dans ton navigateur.
              </div>
            </div>
          )}
        </label>

        {/* Controls row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted mb-1.5">
              Modèle
            </div>
            <select
              value={modelId}
              onChange={(e) => {
                setModelId(e.target.value);
                pipelineRef.current = null; // force reload for the new model
              }}
              disabled={isWorking}
              className="w-full bg-pf-soft border border-pf-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-pf-accent"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.size}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted mb-1.5">
              Langue
            </div>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={isWorking}
              className="w-full bg-pf-soft border border-pf-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-pf-accent"
            >
              {LANG_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={handleRun}
              disabled={!file || isWorking}
              className="w-full bg-pf-accent text-pf-accent-fg font-semibold rounded-lg px-5 py-2.5 text-sm flex items-center justify-center gap-2 disabled:opacity-40"
            >
              {isWorking ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <UploadIcon size={14} />
              )}
              {stageLabel[stage]}
            </button>
          </div>
        </div>

        {/* Progress bar during model download */}
        {stage === "loading-model" && modelProgress ? (
          <div className="bg-pf-elev border border-pf-border rounded-md px-4 py-3">
            <div className="flex items-center justify-between text-xs text-pf-dim mb-1.5">
              <span>Téléchargement du modèle Whisper (1 seule fois, mis en cache)</span>
              <span className="font-mono">{modelProgress.pct}%</span>
            </div>
            <div className="h-1.5 bg-pf-soft rounded-full overflow-hidden">
              <div
                className="h-full bg-pf-accent transition-all"
                style={{ width: `${Math.min(100, modelProgress.pct)}%` }}
              />
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="bg-pf-elev border border-pf-danger/40 rounded-md px-4 py-3 text-sm text-pf-danger">
            ⚠ {error}
          </div>
        ) : null}

        {/* Transcript */}
        <div className="bg-pf-elev border border-pf-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between border-b border-pf-border px-4 py-2.5">
            <div className="text-xs font-semibold uppercase tracking-wider text-pf-muted">
              Transcript
            </div>
            <div className="flex items-center gap-3">
              {transcript ? (
                <span className="text-[11px] text-pf-muted font-mono">
                  {transcript.split(/\s+/).filter(Boolean).length} mots
                </span>
              ) : null}
              <button
                type="button"
                onClick={handleCopy}
                disabled={!transcript}
                className="flex items-center gap-1.5 text-xs text-pf-dim hover:text-pf-accent disabled:opacity-40 disabled:hover:text-pf-dim"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copié" : "Copy"}
              </button>
              <button
                type="button"
                onClick={handleRunCopies}
                disabled={!transcript}
                className="flex items-center gap-1.5 text-xs font-semibold bg-pf-accent text-pf-accent-fg rounded-md px-2.5 py-1 hover:opacity-90 disabled:opacity-40"
                title="Envoie le transcript dans Ad Copies + génère 3 copies + 3 titres"
              >
                <Wand2 size={12} />
                Run ad copy + title
              </button>
            </div>
          </div>
          <div className="px-4 py-4 min-h-[260px] text-sm leading-relaxed whitespace-pre-wrap">
            {transcript ? (
              transcript
            ) : isWorking ? (
              <div className="flex items-center gap-2 text-pf-muted text-xs">
                <Loader2 size={14} className="animate-spin" />
                {stageLabel[stage]}
              </div>
            ) : (
              <div className="text-pf-muted text-xs">
                Le transcript apparaîtra ici une fois la transcription terminée.
              </div>
            )}
          </div>
        </div>
      </section>

      {/* History sidebar */}
      <aside className="bg-pf-elev border border-pf-border rounded-xl p-5 h-fit lg:sticky lg:top-20">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold">History</div>
          {history.length ? (
            <button
              type="button"
              onClick={handleClearHistory}
              className="text-pf-muted hover:text-pf-danger"
              title="Clear history"
            >
              <Trash2 size={13} />
            </button>
          ) : null}
        </div>
        {history.length === 0 ? (
          <p className="text-xs text-pf-muted leading-relaxed">
            Tes 10 dernières transcriptions s&apos;afficheront ici. Tout est
            stocké dans ton navigateur — aucun fichier n&apos;est uploadé.
          </p>
        ) : (
          <ul className="space-y-2">
            {history.map((h, i) => (
              <li key={`${h.at}-${i}`}>
                <button
                  type="button"
                  onClick={() => setTranscript(h.text)}
                  className="w-full text-left bg-pf-soft border border-pf-border hover:border-pf-accent rounded-md px-3 py-2"
                >
                  <div className="text-xs font-semibold text-pf-text truncate">
                    {h.fileName}
                  </div>
                  <div className="text-[11px] text-pf-muted mt-0.5 truncate">
                    {new Date(h.at).toLocaleString()}
                  </div>
                  <div className="text-[11px] text-pf-dim mt-1 line-clamp-2">
                    {h.text.slice(0, 140)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
