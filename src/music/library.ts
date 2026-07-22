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
    '(format:"VBR MP3" OR format:MP3 OR format:"128Kbps MP3")',
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
  // week > downloads: fresher music-ish hits beat ancient public-domain dumps
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

/** Search the Internet Archive for downloadable public MP3 audio. */
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

function isPrivateFile(f: ArchiveFile): boolean {
  return f.private === true || f.private === "true";
}

function fileSize(f: ArchiveFile): number {
  const n = Number(f.size);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function pickBestMp3(files: ArchiveFile[]): ArchiveFile | null {
  const candidates = files
    .filter((f) => /\.mp3$/i.test(f.name) && !isPrivateFile(f))
    .filter((f) => fileSize(f) <= MAX_BYTES);

  if (candidates.length === 0) return null;

  const rank = (f: ArchiveFile): number => {
    const fmt = (f.format ?? "").toLowerCase();
    let r = 0;
    if (fmt.includes("vbr")) r += 3;
    if (fmt.includes("128")) r += 2;
    if (fmt === "mp3") r += 1;
    // Prefer derived/stream copies over giant originals when both exist.
    if (f.source !== "original") r += 1;
    // Prefer smaller among equals (faster load).
    r -= Math.min(2, fileSize(f) / (20 * 1024 * 1024));
    return r;
  };

  candidates.sort((a, b) => rank(b) - rank(a));
  return candidates[0] ?? null;
}

/**
 * Resolve an archive://identifier to a playable public MP3 URL.
 * Skips private files and verifies the download responds with 200/206.
 */
export async function resolvePlayableUrl(track: TrackRef): Promise<string> {
  if (!track.url.startsWith("archive://")) {
    return track.url;
  }

  const identifier = track.url.slice("archive://".length);
  const res = await fetch(
    `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
  );
  if (!res.ok) {
    throw new Error(`Could not load Archive item (${res.status})`);
  }
  const meta = (await res.json()) as { files?: ArchiveFile[] };
  const preferred = pickBestMp3(meta.files ?? []);

  if (!preferred) {
    throw new Error("No public MP3 under 40MB on this item — try another result.");
  }

  const url = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(preferred.name)}`;

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
