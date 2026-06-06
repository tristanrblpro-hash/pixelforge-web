"use client";

// ===========================================================================
// VoSegmentPicker — open the full V1 voice-off, scrub it, pick one OR several
// segments on the waveform, preview them, then stitch the selected ranges
// into a single audio clip used for lipsync.
//
// Everything runs client-side via the Web Audio API:
//   1. fetch + decodeAudioData → an AudioBuffer (the full V1 VO)
//   2. draw the waveform on a canvas with draggable segment overlays
//   3. on "Valider" → slice each segment out of the buffer, concatenate
//      them in order, encode to 16-bit PCM WAV, hand the File back to the
//      caller (which uploads it to Supabase and attaches it to the avatar).
// ===========================================================================

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2, Play, Plus, Scissors, Square, Trash2, X } from "lucide-react";

type Segment = { id: string; start: number; end: number };

const EDGE_PX = 8; // grab tolerance for a segment edge, in pixels

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

// Concatenate the given [start,end] ranges of `src` into one new buffer.
// Used for in-app preview playback — keeps the source rate/channels.
function stitch(
  ctx: AudioContext,
  src: AudioBuffer,
  segments: Segment[],
): AudioBuffer {
  const sr = src.sampleRate;
  const channels = src.numberOfChannels;
  const ranges = segments
    .map((seg) => {
      const a = Math.max(0, Math.floor(Math.min(seg.start, seg.end) * sr));
      const b = Math.min(src.length, Math.ceil(Math.max(seg.start, seg.end) * sr));
      return [a, Math.max(a, b)] as const;
    })
    .filter(([a, b]) => b > a);

  const total = ranges.reduce((acc, [a, b]) => acc + (b - a), 0) || 1;
  const out = ctx.createBuffer(channels, total, sr);
  for (let ch = 0; ch < channels; ch++) {
    const dst = out.getChannelData(ch);
    const from = src.getChannelData(ch);
    let offset = 0;
    for (const [a, b] of ranges) {
      dst.set(from.subarray(a, b), offset);
      offset += b - a;
    }
  }
  return out;
}

const EXPORT_RATE = 24000; // mono 24kHz — ample for lipsync, small upload

// Mix the selected ranges down to a single mono Float32 stream resampled
// to EXPORT_RATE. Keeps the exported WAV small enough to clear Vercel's
// request-body cap even for long selections.
function stitchMonoForExport(src: AudioBuffer, segments: Segment[]): {
  data: Float32Array;
  sampleRate: number;
} {
  const sr = src.sampleRate;
  const channels = src.numberOfChannels;
  const ranges = segments
    .map((seg) => {
      const a = Math.max(0, Math.floor(Math.min(seg.start, seg.end) * sr));
      const b = Math.min(src.length, Math.ceil(Math.max(seg.start, seg.end) * sr));
      return [a, Math.max(a, b)] as const;
    })
    .filter(([a, b]) => b > a);

  // 1. Concatenate ranges into one mono buffer at the source rate.
  const total = ranges.reduce((acc, [a, b]) => acc + (b - a), 0) || 1;
  const mono = new Float32Array(total);
  const chanData: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) chanData.push(src.getChannelData(ch));
  let offset = 0;
  for (const [a, b] of ranges) {
    for (let i = a; i < b; i++) {
      let sum = 0;
      for (let ch = 0; ch < channels; ch++) sum += chanData[ch][i];
      mono[offset++] = sum / channels;
    }
  }

  // 2. Linear-resample to EXPORT_RATE (downsample only; if source is
  //    already <= target, keep it as-is).
  if (sr <= EXPORT_RATE) return { data: mono, sampleRate: sr };
  const ratio = sr / EXPORT_RATE;
  const outLen = Math.floor(mono.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(mono.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
  }
  return { data: out, sampleRate: EXPORT_RATE };
}

// 16-bit PCM mono WAV encoder (little-endian).
function encodeWavMono(data: Float32Array, sr: number): Blob {
  const channels = 1;
  const frames = data.length;
  const blockAlign = channels * 2;
  const dataLen = frames * blockAlign;
  const ab = new ArrayBuffer(44 + dataLen);
  const view = new DataView(ab);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataLen, true);

  let off = 44;
  for (let i = 0; i < frames; i++) {
    let v = data[i];
    v = Math.max(-1, Math.min(1, v));
    view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    off += 2;
  }
  return new Blob([ab], { type: "audio/wav" });
}

export default function VoSegmentPicker({
  audioUrl,
  title = "Sélectionner la voix off (V1)",
  onValidate,
  onClose,
}: {
  audioUrl: string;
  title?: string;
  onValidate: (file: File) => Promise<void> | void;
  onClose: () => void;
}) {
  const idBase = useId();
  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const peaksRef = useRef<Float32Array | null>(null);

  const [duration, setDuration] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const segmentsRef = useRef<Segment[]>([]);
  segmentsRef.current = segments;
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);

  // ---- Load + decode -------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setErr(null);
        const ctx = new (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext)();
        ctxRef.current = ctx;
        const resp = await fetch(audioUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const ab = await resp.arrayBuffer();
        const buf = await ctx.decodeAudioData(ab.slice(0));
        if (cancelled) return;
        bufferRef.current = buf;
        setDuration(buf.duration);
        // Default: one segment covering the whole VO.
        const seg: Segment = { id: `${idBase}-0`, start: 0, end: buf.duration };
        setSegments([seg]);
        setActiveId(seg.id);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      try {
        sourceRef.current?.stop();
      } catch {
        /* noop */
      }
      ctxRef.current?.close().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  // ---- Waveform peaks (computed once after decode) -------------------------
  const computePeaks = useCallback((width: number) => {
    const buf = bufferRef.current;
    if (!buf) return null;
    const data = buf.getChannelData(0);
    const bins = Math.max(1, Math.floor(width));
    const step = Math.floor(data.length / bins) || 1;
    const peaks = new Float32Array(bins);
    for (let i = 0; i < bins; i++) {
      let max = 0;
      const start = i * step;
      const end = Math.min(data.length, start + step);
      for (let j = start; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    return peaks;
  }, []);

  // ---- Draw ----------------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const buf = bufferRef.current;
    if (!canvas || !buf) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Background
    ctx.fillStyle = "#0e0e12";
    ctx.fillRect(0, 0, cssW, cssH);

    let peaks = peaksRef.current;
    if (!peaks || peaks.length !== Math.floor(cssW)) {
      peaks = computePeaks(cssW);
      peaksRef.current = peaks;
    }
    const mid = cssH / 2;

    // Waveform
    ctx.fillStyle = "#3a3a44";
    if (peaks) {
      for (let x = 0; x < peaks.length; x++) {
        const h = peaks[x] * (cssH * 0.92);
        ctx.fillRect(x, mid - h / 2, 1, Math.max(1, h));
      }
    }

    // Segment overlays
    const dur = buf.duration || 1;
    for (const seg of segmentsRef.current) {
      const x0 = (Math.min(seg.start, seg.end) / dur) * cssW;
      const x1 = (Math.max(seg.start, seg.end) / dur) * cssW;
      const active = seg.id === activeIdRef.current;
      ctx.fillStyle = active ? "rgba(124,92,255,0.28)" : "rgba(124,92,255,0.14)";
      ctx.fillRect(x0, 0, x1 - x0, cssH);
      ctx.strokeStyle = active ? "#7c5cff" : "rgba(124,92,255,0.5)";
      ctx.lineWidth = active ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(x0, cssH);
      ctx.moveTo(x1, 0);
      ctx.lineTo(x1, cssH);
      ctx.stroke();
    }
  }, [computePeaks]);

  useEffect(() => {
    if (loading) return;
    draw();
  }, [loading, segments, activeId, draw]);

  useEffect(() => {
    const onResize = () => {
      peaksRef.current = null;
      draw();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  // ---- Canvas pointer interaction -----------------------------------------
  const dragRef = useRef<
    | { mode: "move" | "left" | "right" | "create"; id: string; grabT: number }
    | null
  >(null);

  const xToTime = useCallback((clientX: number) => {
    const canvas = canvasRef.current;
    const buf = bufferRef.current;
    if (!canvas || !buf) return 0;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * buf.duration;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      const buf = bufferRef.current;
      if (!canvas || !buf) return;
      canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      const dur = buf.duration || 1;
      const pxPerSec = rect.width / dur;
      const t = xToTime(e.clientX);

      // Hit-test existing segments: edges first, then body.
      for (const seg of segmentsRef.current) {
        const lx = Math.min(seg.start, seg.end) * pxPerSec;
        const rx = Math.max(seg.start, seg.end) * pxPerSec;
        const px = (e.clientX - rect.left);
        if (Math.abs(px - lx) <= EDGE_PX) {
          dragRef.current = { mode: "left", id: seg.id, grabT: t };
          setActiveId(seg.id);
          return;
        }
        if (Math.abs(px - rx) <= EDGE_PX) {
          dragRef.current = { mode: "right", id: seg.id, grabT: t };
          setActiveId(seg.id);
          return;
        }
      }
      for (const seg of segmentsRef.current) {
        const a = Math.min(seg.start, seg.end);
        const b = Math.max(seg.start, seg.end);
        if (t >= a && t <= b) {
          dragRef.current = { mode: "move", id: seg.id, grabT: t };
          setActiveId(seg.id);
          return;
        }
      }
      // Empty space → start creating a new segment from here.
      const id = `${idBase}-${Date.now().toString(36)}`;
      const seg: Segment = { id, start: t, end: t };
      dragRef.current = { mode: "create", id, grabT: t };
      setSegments((prev) => [...prev, seg]);
      setActiveId(id);
    },
    [idBase, xToTime],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      const buf = bufferRef.current;
      if (!drag || !buf) return;
      const dur = buf.duration;
      const t = Math.max(0, Math.min(dur, xToTime(e.clientX)));
      setSegments((prev) =>
        prev.map((seg) => {
          if (seg.id !== drag.id) return seg;
          if (drag.mode === "left") return { ...seg, start: Math.min(t, seg.end) };
          if (drag.mode === "right") return { ...seg, end: Math.max(t, seg.start) };
          if (drag.mode === "create") return { ...seg, end: t };
          // move
          const len = seg.end - seg.start;
          let ns = seg.start + (t - drag.grabT);
          ns = Math.max(0, Math.min(dur - len, ns));
          return { ...seg, start: ns, end: ns + len };
        }),
      );
      if (drag.mode === "move") drag.grabT = t;
    },
    [xToTime],
  );

  const onPointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    // Drop zero-length / accidental segments.
    setSegments((prev) =>
      prev.filter((seg) => Math.abs(seg.end - seg.start) > 0.05),
    );
  }, []);

  // ---- Playback ------------------------------------------------------------
  const stop = useCallback(() => {
    try {
      sourceRef.current?.stop();
    } catch {
      /* noop */
    }
    sourceRef.current = null;
    setPlaying(false);
  }, []);

  const playBuffer = useCallback(
    (b: AudioBuffer) => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      stop();
      const node = ctx.createBufferSource();
      node.buffer = b;
      node.connect(ctx.destination);
      node.onended = () => setPlaying(false);
      sourceRef.current = node;
      ctx.resume().catch(() => {});
      node.start();
      setPlaying(true);
    },
    [stop],
  );

  const previewOne = useCallback(
    (seg: Segment) => {
      const ctx = ctxRef.current;
      const buf = bufferRef.current;
      if (!ctx || !buf) return;
      playBuffer(stitch(ctx, buf, [seg]));
    },
    [playBuffer],
  );

  const previewAll = useCallback(() => {
    const ctx = ctxRef.current;
    const buf = bufferRef.current;
    if (!ctx || !buf || segments.length === 0) return;
    playBuffer(stitch(ctx, buf, segments));
  }, [playBuffer, segments]);

  // ---- Segment list edits --------------------------------------------------
  const addSegment = useCallback(() => {
    const buf = bufferRef.current;
    if (!buf) return;
    const dur = buf.duration;
    const start = dur * 0.4;
    const end = dur * 0.6;
    const id = `${idBase}-${Date.now().toString(36)}`;
    setSegments((prev) => [...prev, { id, start, end }]);
    setActiveId(id);
  }, [idBase]);

  const removeSegment = useCallback((id: string) => {
    setSegments((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const totalSelected = segments.reduce(
    (acc, s) => acc + Math.abs(s.end - s.start),
    0,
  );

  // ---- Validate ------------------------------------------------------------
  const validate = useCallback(async () => {
    const ctx = ctxRef.current;
    const buf = bufferRef.current;
    if (!ctx || !buf || segments.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      stop();
      const { data, sampleRate } = stitchMonoForExport(buf, segments);
      const blob = encodeWavMono(data, sampleRate);
      const file = new File([blob], `v1-segment-${Date.now()}.wav`, {
        type: "audio/wav",
      });
      await onValidate(file);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [segments, stop, onValidate, onClose]);

  const sorted = [...segments].sort(
    (a, b) => Math.min(a.start, a.end) - Math.min(b.start, b.end),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="bg-pf-elev border border-pf-border rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-pf-border">
          <div className="flex items-center gap-2.5">
            <Scissors size={18} className="text-pf-accent" />
            <h3 className="text-base font-bold">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-pf-dim hover:text-pf-text p-1 rounded-md hover:bg-pf-soft transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-pf-muted py-10 justify-center">
              <Loader2 size={16} className="animate-spin" />
              Chargement de la voix off…
            </div>
          )}

          {err && (
            <div className="text-sm text-pf-danger bg-pf-danger/10 border border-pf-danger/30 rounded-lg px-3 py-2">
              {err}
            </div>
          )}

          {!loading && !err && (
            <>
              <p className="text-sm text-pf-muted leading-relaxed">
                Glisse sur la forme d&apos;onde pour sélectionner un passage.
                Tu peux ajuster les bords, déplacer une sélection, ou en créer
                plusieurs — elles seront recollées dans l&apos;ordre pour faire
                une seule voix off.
              </p>

              {/* Waveform */}
              <div className="rounded-xl overflow-hidden border border-pf-border">
                <canvas
                  ref={canvasRef}
                  className="w-full h-32 touch-none cursor-crosshair block"
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerLeave={onPointerUp}
                />
              </div>

              <div className="flex items-center justify-between text-[11px] font-mono text-pf-muted">
                <span>0:00.0</span>
                <span>Durée totale : {fmt(duration)}</span>
              </div>

              {/* Segment list */}
              <div className="space-y-2">
                {sorted.map((seg, i) => {
                  const a = Math.min(seg.start, seg.end);
                  const b = Math.max(seg.start, seg.end);
                  const active = seg.id === activeId;
                  return (
                    <div
                      key={seg.id}
                      onClick={() => setActiveId(seg.id)}
                      className={`flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                        active
                          ? "border-pf-accent bg-pf-accent/10"
                          : "border-pf-border bg-pf-bg hover:border-pf-accent/50"
                      }`}
                    >
                      <span className="text-xs font-bold font-mono w-6 text-pf-accent">
                        #{i + 1}
                      </span>
                      <span className="text-sm font-mono text-pf-text flex-1">
                        {fmt(a)} → {fmt(b)}{" "}
                        <span className="text-pf-muted">
                          ({fmt(b - a)})
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          previewOne(seg);
                        }}
                        className="text-pf-dim hover:text-pf-accent p-1.5 rounded-md hover:bg-pf-soft transition-colors"
                        title="Écouter ce segment"
                      >
                        <Play size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeSegment(seg.id);
                        }}
                        className="text-pf-dim hover:text-pf-danger p-1.5 rounded-md hover:bg-pf-soft transition-colors"
                        title="Supprimer ce segment"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}

                {segments.length === 0 && (
                  <p className="text-sm text-pf-muted text-center py-3">
                    Aucune sélection. Glisse sur la forme d&apos;onde ou clique
                    « Ajouter un segment ».
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={addSegment}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold bg-pf-soft border border-pf-border hover:border-pf-accent rounded-lg px-3 py-2 transition-colors"
                >
                  <Plus size={14} />
                  Ajouter un segment
                </button>
                {playing ? (
                  <button
                    type="button"
                    onClick={stop}
                    className="inline-flex items-center gap-1.5 text-sm font-semibold bg-pf-soft border border-pf-border hover:border-pf-danger text-pf-danger rounded-lg px-3 py-2 transition-colors"
                  >
                    <Square size={13} className="fill-current" />
                    Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={previewAll}
                    disabled={segments.length === 0}
                    className="inline-flex items-center gap-1.5 text-sm font-semibold bg-pf-soft border border-pf-border hover:border-pf-accent rounded-lg px-3 py-2 disabled:opacity-40 transition-colors"
                  >
                    <Play size={14} />
                    Écouter le montage
                  </button>
                )}
                <span className="text-xs font-mono text-pf-muted ml-auto">
                  Sélection : {fmt(totalSelected)}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-pf-border">
          <button
            type="button"
            onClick={onClose}
            className="text-sm font-semibold text-pf-dim hover:text-pf-text px-4 py-2 rounded-lg hover:bg-pf-soft transition-colors"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={validate}
            disabled={busy || loading || segments.length === 0}
            className="inline-flex items-center gap-2 bg-pf-accent text-pf-accent-fg font-bold rounded-lg px-5 py-2 text-sm disabled:opacity-40 hover:bg-pf-accent/90 transition-colors"
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Scissors size={14} />
            )}
            Valider la sélection
          </button>
        </div>
      </div>
    </div>
  );
}
