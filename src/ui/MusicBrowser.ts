import {
  displayName,
  resolvePlayableUrl,
  searchArchive,
  type TrackRef,
} from "../music/library.ts";
import type { AudioAnalyser } from "../audio/AudioAnalyser.ts";

/**
 * MusicBrowser — splash-panel search against the Internet Archive.
 * Local file upload is handled separately via DropZone.
 */

export interface MusicBrowserOptions {
  form: HTMLFormElement;
  searchInput: HTMLInputElement;
  searchBtn: HTMLButtonElement;
  resultsEl: HTMLElement;
  statusEl: HTMLElement;
  progressRoot: HTMLElement;
  progressFill: HTMLElement;
  analyser: AudioAnalyser;
  onSelect: (track: TrackRef, playableUrl: string) => void | Promise<void>;
}

export class MusicBrowser {
  private readonly opts: MusicBrowserOptions;
  private querySeq = 0;
  private attached = false;
  private picking = false;
  private unsubscribe: (() => void) | null = null;

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
    this.unsubscribe = this.opts.analyser.subscribe((snap) => {
      if (snap.state === "loading") {
        this.showProgress(snap.loadProgress);
        if (snap.fileName && !this.picking) {
          this.setStatus(`Loading ${snap.fileName}…`);
        }
        return;
      }
      // Keep the indeterminate bar up while we resolve Archive metadata.
      if (!this.picking) this.hideProgress();
    });
    this.setStatus("Search free music on Archive.org — or upload a file below");
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.opts.form.removeEventListener("submit", this.onSubmit);
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.hideProgress();
  }

  private async runSearch(): Promise<void> {
    const q = this.opts.searchInput.value.trim();
    if (!q) {
      this.setStatus("Type an artist, genre, or title");
      return;
    }

    const seq = ++this.querySeq;
    this.setStatus("Searching…");
    this.opts.resultsEl.replaceChildren();
    this.opts.searchBtn.disabled = true;

    try {
      const tracks = await searchArchive(q);
      if (seq !== this.querySeq) return;
      if (tracks.length === 0) {
        this.setStatus("No playable results — try a different query");
        return;
      }
      this.setStatus(`${tracks.length} results`);
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
    meta.textContent = track.artist;

    btn.append(title, meta);
    btn.addEventListener("click", () => {
      void this.pick(track, btn);
    });
    return btn;
  }

  private async pick(track: TrackRef, btn: HTMLButtonElement): Promise<void> {
    if (this.picking) return;
    this.picking = true;
    btn.disabled = true;
    btn.classList.add("is-loading");
    this.setStatus(`Loading ${displayName(track)}…`);
    this.showProgress(null);
    try {
      const url = await resolvePlayableUrl(track);
      this.setStatus(`Downloading ${displayName(track)}…`);
      await this.opts.onSelect(track, url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not play track";
      this.setStatus(msg);
      console.error("[llamiyahu] track load failed:", err);
    } finally {
      this.picking = false;
      btn.disabled = false;
      btn.classList.remove("is-loading");
      if (this.opts.analyser.state !== "loading") {
        this.hideProgress();
      }
    }
  }

  private showProgress(ratio: number | null): void {
    const { progressRoot, progressFill } = this.opts;
    progressRoot.hidden = false;
    if (ratio == null) {
      progressRoot.dataset.mode = "indeterminate";
      progressRoot.removeAttribute("aria-valuenow");
      progressFill.style.transform = "";
      return;
    }
    const clamped = Math.max(0, Math.min(1, ratio));
    progressRoot.dataset.mode = "determinate";
    progressRoot.setAttribute("aria-valuenow", String(Math.round(clamped * 100)));
    progressFill.style.transform = `scaleX(${clamped})`;
  }

  private hideProgress(): void {
    const { progressRoot, progressFill } = this.opts;
    progressRoot.hidden = true;
    progressRoot.dataset.mode = "determinate";
    progressRoot.removeAttribute("aria-valuenow");
    progressFill.style.transform = "scaleX(0)";
  }

  private setStatus(message: string): void {
    this.opts.statusEl.textContent = message;
  }
}
