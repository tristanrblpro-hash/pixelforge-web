"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Copy,
  ImagePlus,
  Loader2,
  Send,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";

import {
  MODE_HINTS,
  MODE_LABELS,
  type PromptMode,
} from "@/lib/promptSystemPrompts";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  images?: string[]; // public URLs uploaded to Supabase
};

type ModeMeta = {
  mode: PromptMode;
  tabLabel: string;
  subtitle: string;
};

const MODES: ModeMeta[] = [
  {
    mode: "image",
    tabLabel: "Image · Nano Banana Pro",
    subtitle: "Hyper-realistic iPhone-style images.",
  },
  {
    mode: "video",
    tabLabel: "Video · Kling 3.0",
    subtitle: "B-roll vidéo 9:16, beat par beat.",
  },
  {
    mode: "lipsync",
    tabLabel: "Lipsync · Kling Avatars",
    subtitle: "Prompt minimal — direction only.",
  },
];

const STORAGE_KEY = "pf:promptStudio:v2";

type Stored = Record<PromptMode, ChatMessage[]>;

function loadStored(): Stored {
  if (typeof window === "undefined") {
    return { image: [], video: [], lipsync: [] };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { image: [], video: [], lipsync: [] };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      image: Array.isArray(parsed.image) ? parsed.image : [],
      video: Array.isArray(parsed.video) ? parsed.video : [],
      lipsync: Array.isArray(parsed.lipsync) ? parsed.lipsync : [],
    };
  } catch {
    return { image: [], video: [], lipsync: [] };
  }
}

function extractPromptBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:prompt|md|markdown|text)?\s*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1].trim();
    if (inner) blocks.push(inner);
  }
  return blocks;
}

type AttachedImage = { url: string; localPreview?: string };

export function PromptStudio() {
  const router = useRouter();
  const [activeMode, setActiveMode] = useState<PromptMode>("image");
  const [conversations, setConversations] = useState<Stored>({
    image: [],
    video: [],
    lipsync: [],
  });
  const [input, setInput] = useState("");
  const [attached, setAttached] = useState<AttachedImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Hydrate from localStorage on mount.
  useEffect(() => {
    setConversations(loadStored());
  }, []);

  // Persist on every change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch {
      /* quota errors are non-fatal */
    }
  }, [conversations]);

  // Autoscroll to bottom when messages arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [conversations, activeMode, sending]);

  const messages = conversations[activeMode];

  // Upload one or more files to Supabase via /api/upload.
  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const slots = Math.max(0, 4 - attached.length);
    const toUpload = Array.from(files).slice(0, slots);
    if (toUpload.length === 0) return;
    setUploading(true);
    setError(null);
    for (const f of toUpload) {
      const localPreview = URL.createObjectURL(f);
      try {
        const form = new FormData();
        form.append("file", f);
        const r = await fetch("/api/upload", { method: "POST", body: form });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
        setAttached((prev) => [...prev, { url: data.url, localPreview }]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        URL.revokeObjectURL(localPreview);
      }
    }
    setUploading(false);
  }, [attached.length]);

  const removeAttached = useCallback((idx: number) => {
    setAttached((prev) => {
      const next = [...prev];
      const removed = next.splice(idx, 1)[0];
      if (removed?.localPreview) URL.revokeObjectURL(removed.localPreview);
      return next;
    });
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if ((!text && attached.length === 0) || sending) return;
    setError(null);

    const userMsg: ChatMessage = {
      role: "user",
      content: text,
      images: attached.length ? attached.map((a) => a.url) : undefined,
    };

    const nextHistory: ChatMessage[] = [...messages, userMsg];
    setConversations((prev) => ({ ...prev, [activeMode]: nextHistory }));
    setInput("");
    setAttached([]);
    setSending(true);

    try {
      const r = await fetch("/api/prompt-generator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: activeMode, conversation: nextHistory }),
      });
      const data = await r.json();
      if (!r.ok) {
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      const reply: ChatMessage = {
        role: "assistant",
        content: String(data?.content || "").trim(),
      };
      setConversations((prev) => ({
        ...prev,
        [activeMode]: [...nextHistory, reply],
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setSending(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [activeMode, attached, input, messages, sending]);

  const handleClear = useCallback(() => {
    if (!messages.length) return;
    if (!window.confirm(`Effacer la conversation ${MODE_LABELS[activeMode]} ?`)) return;
    setConversations((prev) => ({ ...prev, [activeMode]: [] }));
    setError(null);
  }, [activeMode, messages.length]);

  const handleCopy = useCallback(async (key: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey((cur) => (cur === key ? null : cur));
      }, 1500);
    } catch {
      /* older browsers */
    }
  }, []);

  // Copy + handoff to /  (Nano Banana Pro). Stores a payload in
  // sessionStorage that HomeStudio drains on mount.
  const handleSendToNano = useCallback(
    async (content: string) => {
      try {
        await navigator.clipboard.writeText(content);
      } catch {
        /* clipboard is best-effort */
      }
      try {
        window.sessionStorage.setItem(
          "pf:nanoHandoff",
          JSON.stringify({
            prompt: content,
            modelKey: "nano-banana-pro",
            autorun: true,
            ts: Date.now(),
          }),
        );
      } catch {
        /* quota */
      }
      router.push("/");
    },
    [router],
  );

  const placeholders: Record<PromptMode, string> = useMemo(
    () => ({
      image:
        "Ex: 62 ans, dermatologue américaine, applique de la crème Orenna dans une salle de bain ensoleillée, plan poitrine.",
      video:
        "Ex: start frame = dermatologue tenant le flacon Orenna. 5s, statique, elle tourne la bouteille vers la caméra, silencieux.",
      lipsync:
        "Ex: regard droit dans la caméra, ton calme et crédible, micro mouvement de tête.",
    }),
    [],
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
      {/* Main chat column */}
      <section className="flex flex-col bg-pf-elev border border-pf-border rounded-xl overflow-hidden min-h-[640px]">
        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-pf-border px-2 pt-2 overflow-x-auto">
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              onClick={() => {
                setActiveMode(m.mode);
                setError(null);
              }}
              className={`px-3 py-2 text-xs font-semibold rounded-t-md whitespace-nowrap transition-colors -mb-px border-b-2 ${
                activeMode === m.mode
                  ? "text-pf-text border-pf-accent"
                  : "text-pf-muted hover:text-pf-text border-transparent"
              }`}
            >
              {m.tabLabel}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 pr-2">
            <button
              type="button"
              onClick={handleClear}
              disabled={!messages.length}
              className="flex items-center gap-1.5 text-xs text-pf-muted hover:text-pf-danger disabled:opacity-40 disabled:hover:text-pf-muted px-2 py-1 rounded"
              title="Effacer la conversation"
            >
              <Trash2 size={13} />
              Clear
            </button>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
          {messages.length === 0 ? (
            <EmptyState mode={activeMode} />
          ) : (
            messages.map((m, i) => (
              <Message
                key={`${activeMode}-${i}`}
                role={m.role}
                content={m.content}
                images={m.images}
                mode={activeMode}
                onCopy={handleCopy}
                onSendToNano={handleSendToNano}
                copiedKey={copiedKey}
                msgKey={`${activeMode}-${i}`}
              />
            ))
          )}
          {sending ? (
            <div className="flex items-center gap-2 text-xs text-pf-muted">
              <Loader2 size={14} className="animate-spin" />
              Claude rédige ton prompt…
            </div>
          ) : null}
        </div>

        {/* Composer */}
        <div className="border-t border-pf-border bg-pf-bg/40 p-3">
          {error ? (
            <div className="mb-2 text-xs text-pf-danger">⚠ {error}</div>
          ) : null}

          {/* Attached images preview row */}
          {attached.length > 0 ? (
            <div className="flex gap-2 items-center mb-2 flex-wrap">
              {attached.map((a, i) => (
                <div
                  key={i}
                  className="relative w-14 h-14 rounded-md overflow-hidden border border-pf-border group/att"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={a.localPreview ?? a.url}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttached(i)}
                    className="absolute top-0.5 right-0.5 bg-pf-bg/80 border border-pf-border rounded p-0.5 opacity-0 group-hover/att:opacity-100 transition-opacity hover:bg-pf-danger hover:text-white"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
              {uploading ? (
                <div className="w-14 h-14 flex items-center justify-center text-pf-muted">
                  <Loader2 size={14} className="animate-spin" />
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || attached.length >= 4}
              className="bg-pf-soft border border-pf-border rounded-lg h-[72px] w-11 flex flex-col items-center justify-center text-pf-dim hover:text-pf-accent hover:border-pf-accent disabled:opacity-40"
              title="Joindre une image (Claude la lira)"
            >
              {uploading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <ImagePlus size={16} />
              )}
              <span className="text-[9px] mt-1">{attached.length}/4</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(e) => {
                handleFiles(e.target.files);
                e.target.value = "";
              }}
              className="hidden"
            />

            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={
                attached.length > 0
                  ? "Décris ce que tu veux à partir de cette image (optionnel)…"
                  : placeholders[activeMode]
              }
              rows={3}
              className="flex-1 bg-pf-soft border border-pf-border rounded-lg px-3 py-2.5 text-sm placeholder:text-pf-muted resize-y min-h-[72px] focus:outline-none focus:border-pf-accent"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={(!input.trim() && attached.length === 0) || sending || uploading}
              className="bg-pf-accent text-pf-accent-fg font-semibold rounded-lg px-4 py-2.5 h-[72px] text-sm flex items-center gap-1.5 disabled:opacity-40"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Generate
            </button>
          </div>
          <div className="mt-2 text-[11px] text-pf-muted">
            ⌘/Ctrl + Enter pour envoyer · attache une image pour la faire analyser.
          </div>
        </div>
      </section>

      {/* Sidebar — mode brief */}
      <aside className="bg-pf-elev border border-pf-border rounded-xl p-5 h-fit lg:sticky lg:top-20">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-7 h-7 rounded-md bg-pf-accent flex items-center justify-center text-pf-accent-fg">
            <Sparkles size={14} />
          </div>
          <div className="text-sm font-semibold">
            {MODE_LABELS[activeMode]}
          </div>
        </div>
        <p className="text-xs text-pf-dim leading-relaxed mb-4">
          {MODE_HINTS[activeMode]}
        </p>

        <div className="text-[10px] font-semibold uppercase tracking-[1.2px] text-pf-muted mb-2">
          Tips
        </div>
        <ul className="text-xs text-pf-dim space-y-1.5 leading-relaxed">
          {activeMode === "image" ? (
            <>
              <li>• Attache une image et dis &laquo; refais ce style &raquo;.</li>
              <li>• Précise l&apos;âge et la nationalité si tu veux une persona.</li>
              <li>• Le bouton ⚡ envoie le prompt directement à Nano Banana Pro.</li>
            </>
          ) : null}
          {activeMode === "video" ? (
            <>
              <li>• Donne durée (5 ou 10 s), caméra et son ou pas.</li>
              <li>• Attache une image pour qu&apos;il s&apos;en inspire pour la scène.</li>
            </>
          ) : null}
          {activeMode === "lipsync" ? (
            <>
              <li>• Ne décris pas le texte parlé — l&apos;audio le fait.</li>
              <li>• Donne juste regard, ton, mains.</li>
            </>
          ) : null}
        </ul>
      </aside>
    </div>
  );
}

function EmptyState({ mode }: { mode: PromptMode }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center py-10">
      <div className="w-12 h-12 rounded-full bg-pf-soft border border-pf-border flex items-center justify-center mb-3">
        <Sparkles size={18} className="text-pf-accent" />
      </div>
      <div className="text-sm font-semibold mb-1">
        {MODE_LABELS[mode]}
      </div>
      <div className="text-xs text-pf-muted max-w-sm">
        {MODE_HINTS[mode]}
      </div>
    </div>
  );
}

function Message({
  role,
  content,
  images,
  mode,
  onCopy,
  onSendToNano,
  copiedKey,
  msgKey,
}: {
  role: "user" | "assistant";
  content: string;
  images?: string[];
  mode: PromptMode;
  onCopy: (key: string, text: string) => void;
  onSendToNano: (text: string) => void;
  copiedKey: string | null;
  msgKey: string;
}) {
  const isUser = role === "user";
  const blocks = !isUser ? extractPromptBlocks(content) : [];

  // For the user side — display attached images above the text bubble.
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] flex flex-col items-end gap-2">
          {images && images.length > 0 ? (
            <div className="flex gap-2 flex-wrap justify-end">
              {images.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={src}
                  alt=""
                  className="w-24 h-24 rounded-md object-cover border border-pf-border"
                />
              ))}
            </div>
          ) : null}
          {content ? (
            <div className="rounded-lg px-4 py-3 text-sm leading-relaxed bg-pf-accent text-pf-accent-fg whitespace-pre-wrap break-words">
              {content}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // Assistant side. If we found one or more fenced prompt blocks, we hide ALL
  // surrounding commentary and only show the black prompt cards. This is
  // what the user asked for — no narration, just the prompt + actions.
  if (blocks.length > 0) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[92%] w-full space-y-3">
          {blocks.map((b, i) => {
            const blockKey = `${msgKey}-block-${i}`;
            const copied = copiedKey === blockKey;
            return (
              <div
                key={blockKey}
                className="bg-pf-bg border border-pf-border rounded-lg overflow-hidden"
              >
                <div className="flex items-center justify-between px-3 py-2 border-b border-pf-border">
                  <span className="text-[10px] uppercase tracking-wider text-pf-muted font-semibold">
                    Prompt #{i + 1}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onCopy(blockKey, b)}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-pf-dim hover:text-pf-accent hover:bg-pf-soft"
                      title="Copier le prompt"
                    >
                      {copied ? <Check size={13} /> : <Copy size={13} />}
                      {copied ? "Copié" : "Copy"}
                    </button>
                    {mode === "image" ? (
                      <button
                        type="button"
                        onClick={() => onSendToNano(b)}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold bg-pf-accent text-pf-accent-fg hover:opacity-90"
                        title="Copie + ouvre Nano Banana Pro + lance la génération"
                      >
                        <Wand2 size={13} />
                        Run
                      </button>
                    ) : null}
                  </div>
                </div>
                <pre className="p-4 text-xs text-pf-text whitespace-pre-wrap break-words font-mono leading-relaxed">
                  {b}
                </pre>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // No prompt block detected (rare — Claude might ask a clarifying question).
  // Show the raw text bubble.
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] bg-pf-soft border border-pf-border rounded-lg px-4 py-3 text-sm leading-relaxed text-pf-text whitespace-pre-wrap break-words">
        {content}
      </div>
    </div>
  );
}
