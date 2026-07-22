/**
 * Music library — Internet Archive search + curated featured tracks.
 *
 * YouTube / Spotify can't stream into a browser AudioContext (ToS + DRM +
 * CORS). The next-best open source is the Internet Archive: free CC/public-
 * domain audio, a CORS-friendly JSON search API, and direct MP3 downloads.
 */

export interface TrackRef {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly url: string;
  readonly source: "featured" | "archive";
}

interface ArchiveSearchDoc {
  identifier?: string;
  title?: string | string[];
  creator?: string | string[];
}

interface ArchiveFile {
  name: string;
  format?: string;
  source?: string;
}

/** Curated CORS-friendly demos (SoundHelix + Archive.org). */
export const FEATURED_TRACKS: readonly TrackRef[] = [
  {
    id: "soundhelix-1",
    title: "SoundHelix Song 1",
    artist: "SoundHelix",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
    source: "featured",
  },
  {
    id: "soundhelix-2",
    title: "SoundHelix Song 2",
    artist: "SoundHelix",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
    source: "featured",
  },
  {
    id: "soundhelix-8",
    title: "SoundHelix Song 8",
    artist: "SoundHelix",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3",
    source: "featured",
  },
  {
    id: "soundhelix-16",
    title: "SoundHelix Song 16",
    artist: "SoundHelix",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-16.mp3",
    source: "featured",
  },
];

function asString(value: string | string[] | undefined, fallback: string): string {
  if (!value) return fallback;
  return Array.isArray(value) ? (value[0] ?? fallback) : value;
}

function buildSearchUrl(query: string, rows: number): string {
  const q = [
    "mediatype:audio",
    "format:MP3",
    `(${query})`,
  ].join(" AND ");
  const params = new URLSearchParams();
  params.set("q", q);
  params.append("fl[]", "identifier");
  params.append("fl[]", "title");
  params.append("fl[]", "creator");
  params.set("sort[]", "downloads desc");
  params.set("rows", String(rows));
  params.set("page", "1");
  params.set("output", "json");
  return `https://archive.org/advancedsearch.php?${params.toString()}`;
}

/** Search the Internet Archive for downloadable MP3 audio. */
export async function searchArchive(
  query: string,
  rows = 12,
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

  return docs
    .filter((d) => typeof d.identifier === "string" && d.identifier.length > 0)
    .map((d) => {
      const id = d.identifier as string;
      return {
        id,
        title: asString(d.title, id),
        artist: asString(d.creator, "Internet Archive"),
        // Resolved to a concrete MP3 URL when the user picks the track.
        url: `archive://${id}`,
        source: "archive" as const,
      };
    });
}

/**
 * Resolve an archive://identifier (or pass-through http URL) to a playable
 * MP3 URL by reading the item's metadata and picking the best audio file.
 */
export async function resolvePlayableUrl(track: TrackRef): Promise<string> {
  if (!track.url.startsWith("archive://")) {
    return track.url;
  }

  const identifier = track.url.slice("archive://".length);
  const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
  if (!res.ok) {
    throw new Error(`Could not load Archive item (${res.status})`);
  }
  const meta = (await res.json()) as { files?: ArchiveFile[] };
  const files = meta.files ?? [];

  const preferred =
    files.find(
      (f) =>
        /\.mp3$/i.test(f.name) &&
        /VBR MP3|128Kbps MP3|MP3/i.test(f.format ?? "") &&
        f.source !== "original",
    ) ??
    files.find((f) => /\.mp3$/i.test(f.name)) ??
    files.find((f) => /\.(ogg|oga|m4a|flac|wav)$/i.test(f.name));

  if (!preferred) {
    throw new Error("No playable audio file found for this Archive item.");
  }

  return `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(preferred.name)}`;
}

export function displayName(track: TrackRef): string {
  if (track.artist && track.artist !== "Internet Archive") {
    return `${track.artist} — ${track.title}`;
  }
  return track.title;
}
