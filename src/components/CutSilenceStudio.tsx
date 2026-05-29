"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  Download,
  FileAudio,
  FileVideo,
  Loader2,
  Paperclip,
  Scissors,
  Upload as UploadIcon,
} from "lucide-react";

import {
  type AttachTarget,
  applyAttach,
  clearAttachTarget,
  getAttachTarget,
  loadBrief,
} from "@/lib/briefs";
import { AttachToBriefButton } from "@/components/AttachToBriefButton";

/**
 * In-browser silence trimmer. Completely free, completely local.
 *
 * Pipeline:
 *   1. AudioContext.decodeAudioData turns the file (audio OR video) into
 *      a multi-channel PCM AudioBuffer.
 *   2. We scan the (mono-mix) signal with 25 ms RMS windows and tag each
 *      window as silent / loud against a dB threshold.
 *   3. Each consecutive run of silent windows is clipped down to
 *      `keepSilenceSec` of silence — anything beyond that is removed.
 *   4. Surviving windows are concatenated per channel and re-encoded as
 *      16-bit PCM WAV (universally supported by audio editors).
 *
 * Output is offered as a downloadable .wav blob.
 */

type Stage = "idle" | "decoding" | "processing" | "done" | "error";

const STORAGE_KEY = "pf:cutSilence:v1";

type Settings = {
  keepSilenceSec: number;
  thresholdDb: number;
};

const DEFAULTS: Settings = {
  keepSilenceSec: 0.1,
  thresholdDb: -38,
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  if (sec < 60) return `${sec.toFixed(2)} s`;
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(1);
  return `${m}m ${s}s`;
}

// Build a 16-bit PCM WAV from an array of channels (Float32 [-1, 1]) at the
// given sample rate. Returns the file as an ArrayBuffer ready for Blob().
function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const numCh = channels.length;
  const length = channels[0]?.length ?? 0;
  const buffer = new ArrayBuffer(44 + length * numCh * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + length * numCh * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // sub-chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true); // bits/sample
  writeStr(36, "data");
  view.setUint32(40, length * numCh * 2, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

export function CutSilenceStudio() {
  const [file, setFile] = useState<File | null>(null);
  const [origUrl, setOrigUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultName, setResultName] = useState<string>("output.wav");
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [keepSilenceSec, setKeepSilenceSec] = useState(DEFAULTS.keepSilenceSec);
  const [thresholdDb, setThresholdDb] = useState(DEFAULTS.thresholdDb);

  const [origDur, setOrigDur] = useState<number | null>(null);
  const [newDur, setNewDur] = useState<number | null>(null);
  const [origSize, setOrigSize] = useState<number | null>(null);
  const [resultSize, setResultSize] = useState<number | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const prevUrls = useRef<string[]>([]);
  const router = useRouter();

  // Brief attach intent — set by /briefs/[id] before navigating here.
  const [attachTarget, setAttachTargetState] = useState<AttachTarget | null>(null);
  const [attachBriefTitle, setAttachBriefTitle] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  useEffect(() => {
    const t = getAttachTarget();
    if (t && (t.kind === "cutVo" || t.kind === "avatarClip")) {
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

  // Note: the manual picker (used when no preset attach target was passed)
  // is now handled by <AttachToBriefButton> globally — its UI lives in
  // AttachDialog.tsx. This component just renders the trigger button on
  // the result; no local state needed.

  // Persist settings.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<Settings>;
      if (typeof s.keepSilenceSec === "number") setKeepSilenceSec(s.keepSilenceSec);
      if (typeof s.thresholdDb === "number") setThresholdDb(s.thresholdDb);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ keepSilenceSec, thresholdDb }),
      );
    } catch {
      /* quota */
    }
  }, [keepSilenceSec, thresholdDb]);

  // Free old object URLs whenever a new one is set so we don't leak memory.
  useEffect(() => {
    return () => {
      for (const u of prevUrls.current) URL.revokeObjectURL(u);
      prevUrls.current = [];
    };
  }, []);

  const setObjectUrl = useCallback(
    (kind: "orig" | "result", url: string | null) => {
      prevUrls.current.push(...(url ? [url] : []));
      if (kind === "orig") setOrigUrl(url);
      else setResultUrl(url);
    },
    [],
  );

  const reset = useCallback(() => {
    setFile(null);
    setObjectUrl("orig", null);
    setObjectUrl("result", null);
    setOrigDur(null);
    setNewDur(null);
    setOrigSize(null);
    setResultSize(null);
    setError(null);
    setStage("idle");
    if (inputRef.current) inputRef.current.value = "";
  }, [setObjectUrl]);

  const handlePick = useCallback(
    (f: File | null) => {
      if (!f) return;
      setError(null);
      setStage("idle");
      setFile(f);
      setOrigSize(f.size);
      const url = URL.createObjectURL(f);
      setObjectUrl("orig", url);
      setObjectUrl("result", null);
      setOrigDur(null);
      setNewDur(null);
      setResultSize(null);
    },
    [setObjectUrl],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) handlePick(f);
    },
    [handlePick],
  );

  // Drain the handoff from /voiceover (or any other tool): we fetch the
  // remote audio URL, wrap it in a File so the existing decode pipeline
  // works unchanged, then run handlePick.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    try {
      const raw = window.sessionStorage.getItem("pf:cutSilenceHandoff");
      if (!raw) return;
      window.sessionStorage.removeItem("pf:cutSilenceHandoff");
      const payload = JSON.parse(raw) as { audioUrl?: string; fileName?: string };
      const url = payload.audioUrl;
      if (!url || typeof url !== "string") return;
      (async () => {
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const blob = await r.blob();
          if (cancelled) return;
          const name = payload.fileName || "voiceover.mp3";
          const file = new File([blob], name, {
            type: blob.type || "audio/mpeg",
            lastModified: Date.now(),
          });
          handlePick(file);
        } catch (e) {
          if (!cancelled) {
            setError(
              `Échec du chargement de l'audio handoff: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      })();
    } catch {
      /* ignore */
    }
    return () => {
      cancelled = true;
    };
    // handlePick is stable enough (only deps are setObjectUrl which is
    // stable) — we intentionally run this effect once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleProcess = useCallback(async () => {
    if (!file) return;
    setError(null);
    setObjectUrl("result", null);
    setNewDur(null);
    setResultSize(null);
    try {
      // 1. Decode.
      setStage("decoding");
      const buf = await file.arrayBuffer();
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new AudioCtx();
      let audio: AudioBuffer;
      try {
        audio = await ctx.decodeAudioData(buf.slice(0));
      } catch (e) {
        await ctx.close();
        throw new Error(
          "Impossible de décoder ce fichier. Essaie un MP3, WAV, M4A, OGG, WebM, ou une vidéo MP4. " +
            (e instanceof Error ? `(${e.message})` : ""),
        );
      }
      setOrigDur(audio.duration);
      const sr = audio.sampleRate;
      const N = audio.length;
      const C = audio.numberOfChannels;

      // 2. Mono RMS scan.
      setStage("processing");
      // Yield once so React can paint the new stage before the heavy loop.
      await new Promise((r) => setTimeout(r, 0));

      const mono = new Float32Array(N);
      for (let c = 0; c < C; c++) {
        const data = audio.getChannelData(c);
        for (let i = 0; i < N; i++) mono[i] += data[i] / C;
      }

      const WIN = Math.max(1, Math.round(sr * 0.025)); // 25 ms windows
      const numWindows = Math.floor(N / WIN);
      const thresholdLin = Math.pow(10, thresholdDb / 20);
      const isSilent = new Uint8Array(numWindows);
      for (let w = 0; w < numWindows; w++) {
        let sum = 0;
        const start = w * WIN;
        for (let i = 0; i < WIN; i++) {
          const s = mono[start + i];
          sum += s * s;
        }
        const rms = Math.sqrt(sum / WIN);
        isSilent[w] = rms < thresholdLin ? 1 : 0;
      }

      // 3. Keep at most keepSilenceSec of each silent run.
      const keepWindows = Math.max(0, Math.round((keepSilenceSec * sr) / WIN));
      const kept = new Uint8Array(numWindows);
      let silentRun = 0;
      let keptCount = 0;
      for (let w = 0; w < numWindows; w++) {
        if (isSilent[w]) {
          silentRun++;
          if (silentRun <= keepWindows) {
            kept[w] = 1;
            keptCount++;
          }
        } else {
          silentRun = 0;
          kept[w] = 1;
          keptCount++;
        }
      }

      if (keptCount === 0) {
        await ctx.close();
        throw new Error(
          "Tout l'audio a été considéré comme silencieux — abaisse le seuil (ex: -50 dB).",
        );
      }

      // 4. Build output channels.
      const outLen = keptCount * WIN;
      const outChannels: Float32Array[] = [];
      for (let c = 0; c < C; c++) {
        const inData = audio.getChannelData(c);
        const out = new Float32Array(outLen);
        let writePos = 0;
        for (let w = 0; w < numWindows; w++) {
          if (kept[w]) {
            const start = w * WIN;
            for (let i = 0; i < WIN; i++) out[writePos++] = inData[start + i];
          }
        }
        outChannels.push(out);
      }

      // 5. Encode to WAV + create download URL.
      const wav = encodeWav(outChannels, sr);
      const blob = new Blob([wav], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      setObjectUrl("result", url);
      setNewDur(outLen / sr);
      setResultSize(blob.size);
      const stem = file.name.replace(/\.[a-z0-9]+$/i, "") || "audio";
      setResultName(`${stem}_cut.wav`);
      setStage("done");
      await ctx.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  }, [file, keepSilenceSec, thresholdDb, setObjectUrl]);

  const isWorking = stage === "decoding" || stage === "processing";

  // Upload the cleaned WAV blob to Supabase Storage, then write the public
  // URL into the provided brief slot. Shared between the preset-target
  // Attach button and the manual picker.
  //
  // Flow: server mints a one-time signed upload URL (using the service
  // role key, ~200 bytes round trip), the browser PUTs the WAV blob
  // straight to Supabase Storage. Vercel never sees the file body, so the
  // 4.5 MB Hobby request cap doesn't apply.
  const attachToTarget = useCallback(
    async (target: AttachTarget) => {
      if (!resultUrl || attaching) return;
      setAttaching(true);
      setError(null);
      try {
        const blob = await fetch(resultUrl).then((r) => r.blob());
        const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        const stem =
          resultName.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9_-]+/gi, "_") ||
          "audio";
        const path = `cut-silence/${stem}_${id}.wav`;

        // 1. Mint signed upload URL on the server (admin key).
        const signRes = await fetch("/api/upload/signed-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        const signRaw = await signRes.text();
        let signData: { signedUrl?: string; publicUrl?: string; error?: string };
        try {
          signData = JSON.parse(signRaw);
        } catch {
          throw new Error(`Signed-url non-JSON (HTTP ${signRes.status}): ${signRaw.slice(0, 160)}`);
        }
        if (!signRes.ok) {
          throw new Error(signData?.error || `Signed-url HTTP ${signRes.status}`);
        }
        if (!signData.signedUrl || !signData.publicUrl) {
          throw new Error("Signed-url response missing fields");
        }

        // 2. PUT the blob directly to Supabase Storage. The signed URL
        //    already encodes auth + bucket + path so we just send bytes.
        const putRes = await fetch(signData.signedUrl, {
          method: "PUT",
          headers: { "Content-Type": "audio/wav" },
          body: blob,
        });
        if (!putRes.ok) {
          const errTxt = await putRes.text();
          throw new Error(`Upload Supabase HTTP ${putRes.status}: ${errTxt.slice(0, 200)}`);
        }

        // 3. Write the public URL into the brief.
        const updated = applyAttach(target, {
          url: signData.publicUrl,
          durationSec: newDur ?? undefined,
        });
        if (!updated) throw new Error("Brief cible introuvable.");
        if (attachTarget) clearAttachTarget();
        router.push(`/briefs/${target.briefId}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setAttaching(false);
      }
    },
    [attachTarget, attaching, newDur, resultName, resultUrl, router],
  );

  const handleAttachToBrief = useCallback(() => {
    if (attachTarget) void attachToTarget(attachTarget);
  }, [attachTarget, attachToTarget]);

  const FileIcon = file ? (file.type.startsWith("video/") ? FileVideo : FileAudio) : UploadIcon;
  const removedSec =
    origDur !== null && newDur !== null ? Math.max(0, origDur - newDur) : null;
  const removedPct =
    origDur !== null && newDur !== null && origDur > 0
      ? Math.round(((origDur - newDur) / origDur) * 100)
      : null;

  return (
    <div className="space-y-4">
      {attachTarget && attachBriefTitle ? (
        <div className="bg-pf-elev border border-pf-accent/50 rounded-xl px-4 py-3 flex items-center gap-2 text-xs">
          <Paperclip size={13} className="text-pf-accent" />
          <span>
            Nettoyage pour le brief{" "}
            <Link
              href={`/briefs/${attachTarget.briefId}`}
              className="font-semibold text-pf-accent"
            >
              {attachBriefTitle}
            </Link>
            . Process puis clique <strong>Attach</strong>.
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* INPUT */}
      <section className="bg-pf-elev border border-pf-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <UploadIcon size={14} className="text-pf-accent" />
            Source
          </h2>
          {file ? (
            <button
              type="button"
              onClick={reset}
              className="text-xs text-pf-muted hover:text-pf-danger"
            >
              Reset
            </button>
          ) : null}
        </div>

        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed py-10 px-5 cursor-pointer transition-colors ${
            dragOver
              ? "border-pf-accent bg-pf-bg/40"
              : "border-pf-border bg-pf-bg/40 hover:border-pf-dim"
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
              </div>
            </div>
          ) : (
            <div className="text-center">
              <div className="text-sm font-semibold">
                Glisse un audio ou une vidéo
              </div>
              <div className="text-xs text-pf-muted mt-1">
                MP3, WAV, M4A, OGG, WebM ou MP4 — décodé localement.
              </div>
            </div>
          )}
        </label>

        {origUrl ? (
          <div>
            <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted mb-1.5">
              Original
            </div>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio controls src={origUrl} className="w-full" />
          </div>
        ) : null}

        {/* Settings */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-pf-border">
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted mb-1.5">
              Keep silence (s)
            </label>
            <input
              type="number"
              min={0}
              max={5}
              step={0.05}
              value={keepSilenceSec}
              onChange={(e) =>
                setKeepSilenceSec(Math.max(0, Math.min(5, Number(e.target.value) || 0)))
              }
              disabled={isWorking}
              className="w-full bg-pf-soft border border-pf-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-pf-accent"
            />
            <p className="text-[11px] text-pf-muted mt-1 leading-snug">
              Durée max de blanc à laisser entre les mots. 0 = couper tout.
            </p>
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted mb-1.5">
              Seuil silence (dB)
            </label>
            <input
              type="number"
              min={-80}
              max={-10}
              step={1}
              value={thresholdDb}
              onChange={(e) =>
                setThresholdDb(Math.max(-80, Math.min(-10, Number(e.target.value) || -38)))
              }
              disabled={isWorking}
              className="w-full bg-pf-soft border border-pf-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-pf-accent"
            />
            <p className="text-[11px] text-pf-muted mt-1 leading-snug">
              En-dessous = silence. Plus bas (-50) = plus sensible.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleProcess}
          disabled={!file || isWorking}
          className="w-full bg-pf-accent text-pf-accent-fg font-semibold rounded-lg px-5 py-3 text-sm flex items-center justify-center gap-2 disabled:opacity-40"
        >
          {isWorking ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Scissors size={14} />
          )}
          {stage === "decoding"
            ? "Décodage…"
            : stage === "processing"
              ? "Découpe en cours…"
              : "Cut silences"}
        </button>

        {error ? (
          <div className="bg-pf-bg border border-pf-danger/40 rounded-md px-3 py-2 text-xs text-pf-danger">
            ⚠ {error}
          </div>
        ) : null}
      </section>

      {/* OUTPUT */}
      <section className="bg-pf-elev border border-pf-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Check size={14} className="text-pf-accent" />
            Résultat
          </h2>
          {resultUrl ? (
            <div className="flex items-center gap-2">
              {attachTarget ? (
                <button
                  type="button"
                  onClick={handleAttachToBrief}
                  disabled={attaching}
                  className="flex items-center gap-1.5 text-xs font-semibold bg-pf-accent text-pf-accent-fg rounded-md px-3 py-1.5 hover:opacity-90 disabled:opacity-40"
                  title={`Attach au brief ${attachBriefTitle}`}
                >
                  {attaching ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Paperclip size={12} />
                  )}
                  Attach
                </button>
              ) : (
                <AttachToBriefButton
                  asset={{
                    kind: "audio",
                    url: resultUrl,
                    durationSec: newDur ?? undefined,
                    label: "cette voix off nettoyée",
                  }}
                  label="Rattacher au brief"
                  size="md"
                  className="flex items-center gap-1.5 text-xs font-semibold bg-pf-accent text-pf-accent-fg rounded-md px-3 py-1.5 hover:opacity-90"
                />
              )}
              <a
                href={resultUrl}
                download={resultName}
                className="flex items-center gap-1.5 text-xs font-semibold bg-pf-soft border border-pf-border text-pf-text rounded-md px-3 py-1.5 hover:border-pf-accent"
              >
                <Download size={13} />
                Download WAV
              </a>
            </div>
          ) : null}
        </div>

        {/* (Picker UI moved to global <AttachToBriefButton> — see header action.) */}

        {resultUrl ? (
          <div className="space-y-3">
            <div>
              <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted mb-1.5">
                Sans blancs
              </div>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio controls src={resultUrl} className="w-full" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Stat
                label="Durée originale"
                value={origDur !== null ? fmtDuration(origDur) : "—"}
                sub={origSize ? fmtBytes(origSize) : ""}
              />
              <Stat
                label="Durée finale"
                value={newDur !== null ? fmtDuration(newDur) : "—"}
                sub={resultSize ? fmtBytes(resultSize) : ""}
                accent
              />
            </div>

            {removedSec !== null ? (
              <div className="bg-pf-bg border border-pf-border rounded-md px-3 py-2 text-xs text-pf-dim">
                <span className="text-pf-accent font-semibold">
                  −{fmtDuration(removedSec)}
                </span>{" "}
                de blancs coupés ({removedPct}% du fichier).
              </div>
            ) : null}
          </div>
        ) : (
          <div className="bg-pf-bg border border-pf-border rounded-lg px-4 py-10 text-center text-xs text-pf-muted">
            {isWorking
              ? "Traitement en cours…"
              : "Le fichier découpé apparaîtra ici, lecteur + bouton télécharger."}
          </div>
        )}

        <div className="border-t border-pf-border pt-3 text-[11px] text-pf-muted leading-relaxed">
          <p className="mb-1.5 font-semibold text-pf-dim">Comment ça marche</p>
          <p>
            1. Le fichier est décodé en local (Web Audio API).
            <br />
            2. On scanne par fenêtres de 25 ms, RMS &lt; seuil = silence.
            <br />
            3. Chaque run de silence est coupé à « Keep silence ».
            <br />
            4. Les segments restants sont réencodés en WAV 16-bit.
            <br />
            Aucun upload, aucun cloud, aucun coût.
          </p>
        </div>
      </section>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-pf-bg border border-pf-border rounded-lg px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted">
        {label}
      </div>
      <div
        className={`text-base font-mono mt-0.5 ${
          accent ? "text-pf-accent font-semibold" : "text-pf-text"
        }`}
      >
        {value}
      </div>
      {sub ? <div className="text-[10px] text-pf-muted mt-0.5">{sub}</div> : null}
    </div>
  );
}
