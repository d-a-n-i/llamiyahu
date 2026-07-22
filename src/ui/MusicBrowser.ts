import {
  FEATURED_TRACKS,
  displayName,
  resolvePlayableUrl,
  searchArchive,
  type TrackRef,
} from "../music/library.ts";

/**
 * MusicBrowser — splash-panel search against the Internet Archive, plus a
 * curated featured row for one-click demos when the network is slow/offline.
 */

export interface MusicBrowserOptions {
  form: HTMLFormElement;
  searchInput: HTMLInputElement;
  searchBtn: HTMLButtonElement;
  resultsEl: HTMLElement;
  featuredEl: HTMLElement;
  statusEl: HTMLElement;
  onSelect: (track: TrackRef, playableUrl: string) => void | Promise<void>;
}

export class MusicBrowser {
  private readonly opts: MusicBrowserOptions;
  private querySeq = 0;
  private attached = false;

  private readonly onSubmit = (e: Event): void => {
    e.preventDefault();
    void this.runSearch();
  };

  constructor(opts: MusicBrowserOptions) {
    this.opts = opts;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.opts.form.addEventListener("submit", this.onSubmit);
    this.renderFeatured();
    this.setStatus("Search Creative Commons audio on the Internet Archive");
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.opts.form.removeEventListener("submit", this.onSubmit);
  }

  private renderFeatured(): void {
    this.opts.featuredEl.replaceChildren();
    for (const track of FEATURED_TRACKS) {
      this.opts.featuredEl.appendChild(this.makeTrackButton(track));
    }
  }

  private async runSearch(): Promise<void> {
    const q = this.opts.searchInput.value.trim();
    if (!q) {
      this.setStatus("Type an artist, genre, or title to search");
      return;
    }

    const seq = ++this.querySeq;
    this.setStatus("Searching Archive.org…");
    this.opts.resultsEl.replaceChildren();
    this.opts.searchBtn.disabled = true;

    try {
      const tracks = await searchArchive(q, 14);
      if (seq !== this.querySeq) return;
      if (tracks.length === 0) {
        this.setStatus("No MP3 results — try a broader query");
        return;
      }
      this.setStatus(`${tracks.length} results from Internet Archive`);
      for (const track of tracks) {
        this.opts.resultsEl.appendChild(this.makeTrackButton(track));
      }
    } catch (err) {
      if (seq !== this.querySeq) return;
      const msg = err instanceof Error ? err.message : "Search failed";
      this.setStatus(msg);
    } finally {
      if (seq === this.querySeq) this.opts.searchBtn.disabled = false;
    }
  }

  private makeTrackButton(track: TrackRef): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "track-btn";
    btn.dataset.trackId = track.id;

    const title = document.createElement("span");
    title.className = "track-btn__title";
    title.textContent = track.title;

    const meta = document.createElement("span");
    meta.className = "track-btn__meta";
    meta.textContent =
      track.source === "featured"
        ? `${track.artist} · demo`
        : `${track.artist} · archive.org`;

    btn.append(title, meta);
    btn.addEventListener("click", () => {
      void this.pick(track, btn);
    });
    return btn;
  }

  private async pick(track: TrackRef, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    btn.classList.add("is-loading");
    this.setStatus(`Loading ${displayName(track)}…`);
    try {
      const url = await resolvePlayableUrl(track);
      await this.opts.onSelect(track, url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not play track";
      this.setStatus(msg);
      console.error("[llamiyahu] track load failed:", err);
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
  }

  private setStatus(message: string): void {
    this.opts.statusEl.textContent = message;
  }
}
