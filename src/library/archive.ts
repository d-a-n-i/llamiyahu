/**
 * Internet Archive helpers for searching free audio and resolving a
 * playable public MP3 under the size cap.
 */

export interface ArchiveTrack {
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

interface ArchiveFileMeta {
  name: string;
  format?: string;
  size?: string | number;
  source?: string;
  private?: boolean | string;
}

const MAX_MP3_BYTES = 40 * 1024 * 1024;

function firstString(value: string | string[] | undefined, fallback: string): string {
  if (!value) return fallback;
  return Array.isArray(value) ? (value[0] ?? fallback) : value;
}

function asArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeLucene(query: string): string {
  return query.replace(/([+\-&|!(){}\[\]^"~*?:\\/])/g, "\\$1");
}

function buildSearchUrl(query: string, rows: number): string {
  const escaped = escapeLucene(query.trim());
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
  params.append("sort[]", "downloads desc");
  params.set("rows", String(rows));
  params.set("page", "1");
  params.set("output", "json");
  return `https://archive.org/advancedsearch.php?${params.toString()}`;
}

function scoreDoc(doc: ArchiveSearchDoc, needle: string): number {
  const title = firstString(doc.title, "").toLowerCase();
  const creator = firstString(doc.creator, "").toLowerCase();
  const collections = asArray(doc.collection).map((c) => c.toLowerCase());
  let score = Math.log10((doc.downloads ?? 0) + 10);

  if (title.includes(needle)) score += 8;
  if (creator.includes(needle)) score += 6;
  if (title.startsWith(needle) || creator.startsWith(needle)) score += 3;

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

  const id = (doc.identifier ?? "").toLowerCase();
  if (/podcast|lecture|sermon|audiobook|librivox|radio/.test(id + title)) {
    score -= 10;
  }
  return score;
}

export async function searchArchive(
  query: string,
  rows = 24,
): Promise<ArchiveTrack[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const res = await fetch(buildSearchUrl(trimmed, rows));
  if (!res.ok) throw new Error(`Archive search failed (${res.status})`);

  const json = (await res.json()) as {
    response?: { docs?: ArchiveSearchDoc[] };
  };
  const docs = json.response?.docs ?? [];
  const needle = trimmed.toLowerCase();

  return docs
    .filter((d) => typeof d.identifier === "string" && d.identifier.length > 0)
    .map((doc) => ({ doc, score: scoreDoc(doc, needle) }))
    .filter((entry) => entry.score > -5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 14)
    .map(({ doc }) => {
      const id = doc.identifier as string;
      return {
        id,
        title: firstString(doc.title, id),
        artist: firstString(doc.creator, "Unknown"),
        url: `archive://${id}`,
        source: "archive" as const,
      };
    });
}

function isPrivateFile(file: ArchiveFileMeta): boolean {
  return file.private === true || file.private === "true";
}

function fileSize(file: ArchiveFileMeta): number {
  const n = Number(file.size);
  return Number.isFinite(n) ? n : Infinity;
}

function pickBestMp3(files: ArchiveFileMeta[]): ArchiveFileMeta | null {
  const candidates = files
    .filter((f) => /\.mp3$/i.test(f.name) && !isPrivateFile(f))
    .filter((f) => fileSize(f) <= MAX_MP3_BYTES);
  if (candidates.length === 0) return null;

  const rank = (file: ArchiveFileMeta): number => {
    const format = (file.format ?? "").toLowerCase();
    let score = 0;
    if (format.includes("vbr")) score += 3;
    if (format.includes("128")) score += 2;
    if (format === "mp3") score += 1;
    if (file.source !== "original") score += 1;
    score -= Math.min(2, fileSize(file) / (20 * 1024 * 1024));
    return score;
  };

  candidates.sort((a, b) => rank(b) - rank(a));
  return candidates[0] ?? null;
}

/** Resolve an `archive://identifier` track to a direct download URL. */
export async function resolveArchiveUrl(track: ArchiveTrack): Promise<string> {
  if (!track.url.startsWith("archive://")) return track.url;

  const identifier = track.url.slice("archive://".length);
  const metaRes = await fetch(
    `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
  );
  if (!metaRes.ok) {
    throw new Error(`Could not load Archive item (${metaRes.status})`);
  }

  const meta = (await metaRes.json()) as { files?: ArchiveFileMeta[] };
  const best = pickBestMp3(meta.files ?? []);
  if (!best) {
    throw new Error("No public MP3 under 40MB on this item — try another result.");
  }

  const url = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(best.name)}`;
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
    // Some CDNs reject HEAD; allow GET/decode to decide later.
  }
  return url;
}

export function formatTrackLabel(track: ArchiveTrack): string {
  return track.artist && track.artist !== "Unknown"
    ? `${track.artist} — ${track.title}`
    : track.title;
}
