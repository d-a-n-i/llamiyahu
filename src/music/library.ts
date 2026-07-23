/**
 * Music library — Internet Archive search.
 *
 * YouTube / Spotify can't stream into a browser AudioContext (ToS + DRM +
 * CORS). Archive.org search/metadata/public MP3s send ACAO: * and work with
 * fetch → decodeAudioData. Private IA files (401) and non-CORS hosts do not.
 */

export interface TrackRef {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly url: string;
  readonly source: "archive";
  /** Direct media URL, set after a successful playability probe. */
  readonly playableUrl?: string;
}

export interface SearchPlayableOptions {
  /** Used to probe-decode a prefix of each candidate file. */
  audioContext: AudioContext;
  /** Max results to return after filtering. */
  limit?: number;
  /** How many Archive hits to consider before probing. */
  candidateRows?: number;
  /** Parallel probe workers. */
  concurrency?: number;
  /** Abort in-flight probes (e.g. new search started). */
  signal?: AbortSignal;
  /** Called as each track passes validation (progressive UI). */
  onTrack?: (track: TrackRef) => void;
}

interface ArchiveSearchDoc {
  identifier?: string;
  title?: string | string[];
  creator?: string | string[];
  collection?: string | string[];
  downloads?: number;
}

interface ArchiveFile {
  name: string;
  format?: string;
  source?: string;
  private?: string | boolean;
  size?: string;
}

const MAX_BYTES = 40 * 1024 * 1024; // skip huge dumps; keep decode snappy
const PROBE_BYTES_QUICK = 256 * 1024;
const PROBE_BYTES_DEEP = 1024 * 1024; // covers large ID3/album-art prefixes
const MIN_PROBE_BYTES = 2 * 1024;

function asString(value: string | string[] | undefined, fallback: string): string {
  if (!value) return fallback;
  return Array.isArray(value) ? (value[0] ?? fallback) : value;
}

function asStringList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/** Escape Lucene special characters so user queries don't break the parser. */
function escapeLucene(raw: string): string {
  return raw.replace(/([+\-&|!(){}\[\]^"~*?:\\/])/g, "\\$1");
}

function buildSearchUrl(query: string, rows: number): string {
  const escaped = escapeLucene(query.trim());
  // Prefer title/creator matches; exclude speech/podcast-heavy collections that
  // dominate "downloads" rankings and feel like bad search results.
  const q = [
    "mediatype:audio",
    '(format:"VBR MP3" OR format:MP3 OR format:"128Kbps MP3" OR format:"Ogg Vorbis" OR format:WAVE OR format:Flac)',
    `(title:(${escaped}) OR creator:(${escaped}) OR subject:(${escaped}))`,
    "-collection:(librivoxaudio OR librivox OR podcasts OR radio OR community_media OR oldtimeradio OR radio_programs OR radio_archive)",
  ].join(" AND ");

  const params = new URLSearchParams();
  params.set("q", q);
  params.append("fl[]", "identifier");
  params.append("fl[]", "title");
  params.append("fl[]", "creator");
  params.append("fl[]", "collection");
  params.append("fl[]", "downloads");
  params.append("sort[]", "downloads desc");
  params.set("rows", String(rows));
  params.set("page", "1");
  params.set("output", "json");
  return `https://archive.org/advancedsearch.php?${params.toString()}`;
}

function scoreDoc(doc: ArchiveSearchDoc, queryLower: string): number {
  const title = asString(doc.title, "").toLowerCase();
  const artist = asString(doc.creator, "").toLowerCase();
  const collections = asStringList(doc.collection).map((c) => c.toLowerCase());
  let score = Math.log10((doc.downloads ?? 0) + 10);

  if (title.includes(queryLower)) score += 8;
  if (artist.includes(queryLower)) score += 6;
  if (title.startsWith(queryLower) || artist.startsWith(queryLower)) score += 3;

  const musicCollections = [
    "freemusicarchive",
    "netlabels",
    "opensource_audio",
    "jamendo-albums",
    "audio_music",
    "musopen",
  ];
  if (collections.some((c) => musicCollections.some((m) => c.includes(m)))) {
    score += 5;
  }

  // Penalize obvious speech / lecture identifiers.
  const id = (doc.identifier ?? "").toLowerCase();
  if (/podcast|lecture|sermon|audiobook|librivox|radio/.test(id + title)) {
    score -= 10;
  }

  return score;
}

function isPrivateFile(f: ArchiveFile): boolean {
  return f.private === true || f.private === "true";
}

function fileSize(f: ArchiveFile): number {
  const n = Number(f.size);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function isPlayableName(name: string): boolean {
  return /\.(mp3|ogg|oga|wav|wave|flac|m4a)$/i.test(name);
}

function pickBestAudio(files: ArchiveFile[]): ArchiveFile | null {
  const candidates = files
    .filter((f) => isPlayableName(f.name) && !isPrivateFile(f))
    .filter((f) => fileSize(f) <= MAX_BYTES)
    // Skip tiny stubs / empty placeholders.
    .filter((f) => fileSize(f) >= 32 * 1024);

  if (candidates.length === 0) return null;

  const rank = (f: ArchiveFile): number => {
    const fmt = (f.format ?? "").toLowerCase();
    const name = f.name.toLowerCase();
    let r = 0;
    if (name.endsWith(".mp3") || fmt.includes("mp3") || fmt.includes("vbr")) r += 5;
    if (fmt.includes("vbr")) r += 2;
    if (fmt.includes("128")) r += 1;
    if (name.endsWith(".ogg") || name.endsWith(".oga") || fmt.includes("ogg")) r += 4;
    if (name.endsWith(".wav") || fmt.includes("wave") || fmt === "wav") r += 3;
    if (name.endsWith(".flac") || fmt.includes("flac")) r += 2;
    if (name.endsWith(".m4a") || fmt.includes("m4a") || fmt.includes("aac")) r += 2;
    // Prefer derived/stream copies over giant originals when both exist.
    if (f.source !== "original") r += 1;
    // Prefer smaller among equals (faster load).
    r -= Math.min(2, fileSize(f) / (20 * 1024 * 1024));
    return r;
  };

  candidates.sort((a, b) => rank(b) - rank(a));
  return candidates[0] ?? null;
}

/** True if the byte prefix looks like real audio rather than HTML/JSON/error pages. */
export function looksLikeAudio(data: ArrayBuffer): boolean {
  if (data.byteLength < 12) return false;
  const bytes = new Uint8Array(data);
  const ascii = String.fromCharCode(...bytes.subarray(0, Math.min(16, bytes.length)));

  // Reject common non-audio payloads Archive sometimes returns with 200.
  if (/^\s*</.test(ascii) || /^<!doctype/i.test(ascii) || /^\{/.test(ascii)) {
    return false;
  }

  // ID3v2 tag
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  // MP3 frame sync (11 set bits)
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true;
  // Ogg
  if (ascii.startsWith("OggS")) return true;
  // WAV / AIFF
  if (ascii.startsWith("RIFF") || ascii.startsWith("FORM")) return true;
  // FLAC
  if (ascii.startsWith("fLaC")) return true;
  // MP4 / M4A
  if (bytes.length >= 8) {
    const brand = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    if (brand === "ftyp") return true;
  }
  return false;
}

function downloadUrl(identifier: string, fileName: string): string {
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(fileName)}`;
}

async function resolveAudioUrl(identifier: string, signal?: AbortSignal): Promise<string | null> {
  const res = await fetch(
    `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
    { signal },
  );
  if (!res.ok) return null;
  const meta = (await res.json()) as { files?: ArchiveFile[] };
  const preferred = pickBestAudio(meta.files ?? []);
  if (!preferred) return null;
  return downloadUrl(identifier, preferred.name);
}

/**
 * Fetch a prefix of the file and confirm the browser can decode it.
 * Rejects HTML error pages, empty stubs, and undecodable payloads up front.
 */
async function probePlayableUrl(
  url: string,
  audioContext: AudioContext,
  signal?: AbortSignal,
): Promise<boolean> {
  // Try a small prefix first; if it looks like audio but won't decode
  // (common with huge ID3/album-art tags), retry with a deeper range.
  for (const size of [PROBE_BYTES_QUICK, PROBE_BYTES_DEEP]) {
    if (signal?.aborted) return false;

    let res: Response;
    try {
      res = await fetch(url, {
        mode: "cors",
        credentials: "omit",
        headers: { Range: `bytes=0-${size - 1}` },
        signal,
      });
    } catch {
      return false;
    }

    if (!(res.ok || res.status === 206)) return false;

    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (type && /text\/html|application\/json|text\/plain/.test(type)) {
      return false;
    }

    let data: ArrayBuffer;
    try {
      data = await res.arrayBuffer();
    } catch {
      return false;
    }

    if (data.byteLength < MIN_PROBE_BYTES) return false;
    if (!looksLikeAudio(data)) return false;

    try {
      await audioContext.decodeAudioData(data.slice(0));
      return true;
    } catch {
      // Fall through to a deeper probe when possible.
      if (size >= PROBE_BYTES_DEEP || data.byteLength < size) {
        return false;
      }
    }
  }
  return false;
}

async function validateCandidate(
  track: TrackRef,
  audioContext: AudioContext,
  signal?: AbortSignal,
): Promise<TrackRef | null> {
  if (signal?.aborted) return null;
  try {
    const identifier = track.url.startsWith("archive://")
      ? track.url.slice("archive://".length)
      : track.id;
    const playableUrl = await resolveAudioUrl(identifier, signal);
    if (!playableUrl) return null;
    const ok = await probePlayableUrl(playableUrl, audioContext, signal);
    if (!ok) return null;
    return { ...track, playableUrl };
  } catch {
    return null;
  }
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R | null>,
  opts: {
    signal?: AbortSignal;
    shouldStop?: () => boolean;
  } = {},
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;

  const run = async (): Promise<void> => {
    while (cursor < items.length) {
      if (opts.signal?.aborted || opts.shouldStop?.()) return;
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      const value = await worker(item);
      if (value != null) results.push(value);
    }
  };

  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

/**
 * Search Archive.org, then probe each hit so only browser-decodable public
 * audio appears in the result list.
 */
export async function searchArchivePlayable(
  query: string,
  options: SearchPlayableOptions,
): Promise<TrackRef[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const limit = options.limit ?? 10;
  const candidateRows = options.candidateRows ?? 36;
  const concurrency = options.concurrency ?? 4;
  const { audioContext, signal, onTrack } = options;

  const res = await fetch(buildSearchUrl(trimmed, candidateRows), { signal });
  if (!res.ok) {
    throw new Error(`Archive search failed (${res.status})`);
  }
  const json = (await res.json()) as {
    response?: { docs?: ArchiveSearchDoc[] };
  };
  const docs = json.response?.docs ?? [];
  const qLower = trimmed.toLowerCase();

  const candidates: TrackRef[] = docs
    .filter((d) => typeof d.identifier === "string" && d.identifier.length > 0)
    .map((d) => ({ doc: d, score: scoreDoc(d, qLower) }))
    .filter((x) => x.score > -5)
    .sort((a, b) => b.score - a.score)
    .map(({ doc }) => {
      const id = doc.identifier as string;
      return {
        id,
        title: asString(doc.title, id),
        artist: asString(doc.creator, "Unknown"),
        url: `archive://${id}`,
        source: "archive" as const,
      };
    });

  const playable: TrackRef[] = [];

  await mapPool(
    candidates,
    concurrency,
    async (track) => {
      if (playable.length >= limit) return null;
      const validated = await validateCandidate(track, audioContext, signal);
      if (!validated) return null;
      if (playable.length >= limit) return null;
      playable.push(validated);
      onTrack?.(validated);
      return validated;
    },
    {
      signal,
      shouldStop: () => playable.length >= limit || !!signal?.aborted,
    },
  );

  return playable.slice(0, limit);
}

/** @deprecated Prefer searchArchivePlayable — unvalidated hits often fail decode. */
export async function searchArchive(
  query: string,
  rows = 24,
): Promise<TrackRef[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const res = await fetch(buildSearchUrl(trimmed, rows));
  if (!res.ok) {
    throw new Error(`Archive search failed (${res.status})`);
  }
  const json = (await res.json()) as {
    response?: { docs?: ArchiveSearchDoc[] };
  };
  const docs = json.response?.docs ?? [];
  const qLower = trimmed.toLowerCase();

  return docs
    .filter((d) => typeof d.identifier === "string" && d.identifier.length > 0)
    .map((d) => ({ doc: d, score: scoreDoc(d, qLower) }))
    .filter((x) => x.score > -5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 14)
    .map(({ doc }) => {
      const id = doc.identifier as string;
      return {
        id,
        title: asString(doc.title, id),
        artist: asString(doc.creator, "Unknown"),
        url: `archive://${id}`,
        source: "archive" as const,
      };
    });
}

/**
 * Resolve an archive://identifier to a playable public audio URL.
 * Uses a cached playableUrl when the track was pre-validated.
 */
export async function resolvePlayableUrl(track: TrackRef): Promise<string> {
  if (track.playableUrl) return track.playableUrl;
  if (!track.url.startsWith("archive://")) {
    return track.url;
  }

  const identifier = track.url.slice("archive://".length);
  const url = await resolveAudioUrl(identifier);
  if (!url) {
    throw new Error("No public audio under 40MB on this item — try another result.");
  }

  // HEAD first: catch private/401 before we burn a full download.
  try {
    const head = await fetch(url, { method: "HEAD" });
    if (!head.ok) {
      throw new Error(
        head.status === 401 || head.status === 403
          ? "This Archive file is restricted — try another result."
          : `Audio unavailable (${head.status}).`,
      );
    }
  } catch (err) {
    if (err instanceof Error && /restricted|unavailable/i.test(err.message)) {
      throw err;
    }
    // Some CDNs reject HEAD; fall through and let GET decide.
  }

  return url;
}

export function displayName(track: TrackRef): string {
  if (track.artist && track.artist !== "Unknown") {
    return `${track.artist} — ${track.title}`;
  }
  return track.title;
}
