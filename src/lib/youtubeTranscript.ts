// YouTube transcript extractor.
//
// Strategy: fetch the YouTube watch page HTML, parse out
// `ytInitialPlayerResponse` (the JSON the JS player uses), pick a caption
// track (preferred language first, then anything available, then ASR
// auto-captions as a last resort), fetch that track's XML and decode the
// `<text>` elements into a plain transcript.
//
// Why not use a dedicated npm package? They all do exactly this under the
// hood; doing it inline keeps the dependency tree small and lets us tune
// language preference + error messages for our use case (transcribing
// competitor ads to study them — works in French + English).
//
// Caveats: YouTube can rename the player-response key or change the XML
// schema at any time. If extraction breaks, the fix is usually to update
// the two regexes below.

export type CaptionSegment = {
  /** Spoken text for the segment, HTML-decoded. */
  text: string;
  /** Start time in seconds. */
  start: number;
  /** Segment duration in seconds. */
  duration: number;
};

export type YoutubeTranscript = {
  /** BCP-47 code of the picked caption track (e.g. "en", "fr"). */
  language: string;
  /** True if YouTube auto-generated the captions (no human edit). */
  auto: boolean;
  /** Per-segment captions with timecodes. */
  segments: CaptionSegment[];
  /** Whole transcript as a single space-joined string. */
  text: string;
  /** Video metadata for the UI. */
  videoId: string;
  title?: string;
  durationSec?: number;
  channel?: string;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchYoutubeTranscript(
  rawUrl: string,
  preferLangs: string[] = ["en", "fr"],
): Promise<YoutubeTranscript> {
  const videoId = extractVideoId(rawUrl);
  if (!videoId) {
    throw new Error("URL YouTube invalide (vidéo introuvable dans l'URL fournie).");
  }

  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} en chargeant la page YouTube.`);
  }
  const html = await res.text();

  const player = extractPlayerResponse(html);
  if (!player) {
    throw new Error(
      "Impossible de lire la configuration du player YouTube. La vidéo est peut-être privée ou bloquée géographiquement.",
    );
  }

  // Detect playability errors early — videos that need age verification or
  // are removed don't carry caption tracks.
  const status = player?.playabilityStatus?.status;
  if (status && status !== "OK") {
    const reason =
      player?.playabilityStatus?.reason ||
      player?.playabilityStatus?.errorScreen?.playerErrorMessageRenderer?.reason
        ?.simpleText ||
      "non lisible";
    throw new Error(`YouTube refuse la vidéo : ${reason}`);
  }

  const tracks: CaptionTrack[] =
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) {
    throw new Error(
      "Aucun sous-titre disponible pour cette vidéo (ni manuel, ni auto-généré). YouTube ne génère pas toujours de captions sur les courtes vidéos ou les contenus musicaux.",
    );
  }

  const chosen = pickBestTrack(tracks, preferLangs);

  // Force JSON3 output — much easier to parse than the default srv1 XML.
  const trackUrl = `${chosen.baseUrl}&fmt=json3`;
  const trackRes = await fetch(trackUrl, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!trackRes.ok) {
    throw new Error(`HTTP ${trackRes.status} en chargeant le sous-titre.`);
  }
  const json = (await trackRes.json()) as Json3Track;
  const segments = parseJson3(json);
  if (segments.length === 0) {
    throw new Error("Le sous-titre est vide.");
  }

  const text = segments
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const details = player?.videoDetails ?? {};
  return {
    videoId,
    language: chosen.languageCode,
    auto: chosen.kind === "asr",
    segments,
    text,
    title: typeof details.title === "string" ? details.title : undefined,
    channel: typeof details.author === "string" ? details.author : undefined,
    durationSec:
      typeof details.lengthSeconds === "string"
        ? Number(details.lengthSeconds)
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// URL → video id
//
// Handles every reasonable YouTube URL form:
//   - https://www.youtube.com/watch?v=ID
//   - https://youtu.be/ID
//   - https://www.youtube.com/embed/ID
//   - https://www.youtube.com/shorts/ID
//   - https://m.youtube.com/...
//   - or just the bare 11-char video id.
// ---------------------------------------------------------------------------

export function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (u.hostname.endsWith("youtube.com") || u.hostname.endsWith("youtube-nocookie.com")) {
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/^\/(?:embed|shorts|v|live)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
  } catch {
    /* not a URL */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type CaptionTrack = {
  baseUrl: string;
  languageCode: string;
  name?: { simpleText?: string };
  vssId?: string;
  /** "asr" when the track is auto-generated. */
  kind?: string;
};

type PlayerResponse = {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
  videoDetails?: {
    title?: string;
    author?: string;
    lengthSeconds?: string;
  };
  playabilityStatus?: {
    status?: string;
    reason?: string;
    errorScreen?: {
      playerErrorMessageRenderer?: {
        reason?: { simpleText?: string };
      };
    };
  };
};

type Json3Track = {
  events?: Array<{
    tStartMs?: number;
    dDurationMs?: number;
    segs?: Array<{ utf8?: string }>;
  }>;
};

// Try a couple of regexes — YouTube ships slightly different HTML formats
// depending on the viewer (logged in vs logged out, mobile vs desktop).
function extractPlayerResponse(html: string): PlayerResponse | null {
  const patterns = [
    /var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*var/,
    /ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*<\/script>/,
    /ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*\(function/,
    /"playerResponse":\s*(\{.+?\})\s*,\s*"adServerPath"/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (!m) continue;
    try {
      return JSON.parse(m[1]) as PlayerResponse;
    } catch {
      /* try next pattern */
    }
  }
  return null;
}

function pickBestTrack(
  tracks: CaptionTrack[],
  preferLangs: string[],
): CaptionTrack {
  // 1. Preferred language, manual caption.
  for (const lang of preferLangs) {
    const t = tracks.find((x) => x.languageCode === lang && x.kind !== "asr");
    if (t) return t;
  }
  // 2. Preferred language, ASR.
  for (const lang of preferLangs) {
    const t = tracks.find((x) => x.languageCode === lang && x.kind === "asr");
    if (t) return t;
  }
  // 3. Any manual caption.
  const anyManual = tracks.find((x) => x.kind !== "asr");
  if (anyManual) return anyManual;
  // 4. First track, whatever it is.
  return tracks[0];
}

function parseJson3(json: Json3Track): CaptionSegment[] {
  const out: CaptionSegment[] = [];
  for (const ev of json.events ?? []) {
    if (!ev.segs || typeof ev.tStartMs !== "number") continue;
    const text = ev.segs.map((s) => s.utf8 ?? "").join("");
    const cleaned = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    out.push({
      text: decodeEntities(cleaned),
      start: ev.tStartMs / 1000,
      duration: (ev.dDurationMs ?? 0) / 1000,
    });
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}
