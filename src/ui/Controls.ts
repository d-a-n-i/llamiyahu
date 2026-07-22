import type { AudioAnalyser, AudioAnalyserSnapshot } from "../audio/AudioAnalyser.ts";
import type { VisualizerEngine } from "../visualizer/VisualizerEngine.ts";

/**
 * Controls
 * -----------------------------------------------------------------------------
 * Owns the playback overlay: play/pause button, scrub bar with live time
 * tracking, mode toggle pills, and the "load another file" button.
 *
 * Key behaviours:
 *  - Subscribes to AudioAnalyser snapshots so play/pause/duration/filename
 *    stay in sync with the source of truth.
 *  - Runs an internal rAF only while playback is active to repaint the
 *    scrub head / current time, then stops to save battery.
 *  - Auto-hides the overlay during active playback after a few seconds of
 *    pointer/keyboard idleness; any movement, key press, or pause brings
 *    it back instantly.
 *  - Keyboard shortcuts: Space (toggle), Left/Right (5s seek), M (cycle mode).
 */

export interface ControlsOptions {
  app: HTMLElement;
  controlsRoot: HTMLElement;
  topbar: HTMLElement;
  playBtn: HTMLButtonElement;
  loadBtn: HTMLButtonElement;
  libraryBtn: HTMLButtonElement;
  modesContainer: HTMLElement;
  scrubInput: HTMLInputElement;
  scrubFill: HTMLElement;
  scrubHead: HTMLElement;
  timeCurrent: HTMLElement;
  timeTotal: HTMLElement;
  trackLabel: HTMLElement;
  analyser: AudioAnalyser;
  engine: VisualizerEngine;
  onRequestLoad: () => void;
  onRequestLibrary: () => void;
  hideAfterMs?: number;
}

const DEFAULT_HIDE_AFTER_MS = 2400;

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export class Controls {
  private readonly opts: ControlsOptions;
  private readonly hideAfterMs: number;

  private hideTimer = 0;
  private hovering = false;
  private seeking = false;
  private rafId = 0;
  private unsubscribe: (() => void) | null = null;
  private lastSnapshot: AudioAnalyserSnapshot | null = null;

  // Bound listeners we need handles for detachment.
  private readonly onAnyActivity = (): void => this.show();
  private readonly onKeyDown = (e: KeyboardEvent): void => this.handleKeydown(e);

  constructor(opts: ControlsOptions) {
    this.opts = opts;
    this.hideAfterMs = opts.hideAfterMs ?? DEFAULT_HIDE_AFTER_MS;
  }

  attach(): void {
    this.renderModes();
    this.bindControls();
    this.bindActivity();
    this.unsubscribe = this.opts.analyser.subscribe((snap) => this.onSnapshot(snap));
    this.show();
  }

  detach(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.hideTimer !== 0) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = 0;
    }
    document.removeEventListener("pointermove", this.onAnyActivity);
    document.removeEventListener("touchstart", this.onAnyActivity);
    document.removeEventListener("wheel", this.onAnyActivity);
    document.removeEventListener("keydown", this.onKeyDown);
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  private bindControls(): void {
    const { playBtn, loadBtn, libraryBtn, scrubInput, controlsRoot, analyser } = this.opts;

    playBtn.addEventListener("click", () => {
      // togglePlay calls unlock + resume implicitly via play().
      void analyser.togglePlay().catch((err) => console.error(err));
      this.show();
    });

    loadBtn.addEventListener("click", () => {
      this.opts.onRequestLoad();
    });

    libraryBtn.addEventListener("click", () => {
      this.opts.onRequestLibrary();
      this.show();
    });

    scrubInput.addEventListener("pointerdown", () => {
      this.seeking = true;
      this.show();
    });
    scrubInput.addEventListener("pointerup", () => {
      this.seeking = false;
      this.show();
    });
    scrubInput.addEventListener("touchend", () => {
      this.seeking = false;
      this.show();
    });
    scrubInput.addEventListener("input", () => {
      const max = Number(scrubInput.max || "1000") || 1000;
      const ratio = Number(scrubInput.value) / max;
      const dur = analyser.duration;
      if (dur > 0) {
        const t = ratio * dur;
        this.updateScrubVisual(ratio);
        this.opts.timeCurrent.textContent = formatTime(t);
        analyser.seek(t);
      }
    });

    controlsRoot.addEventListener("pointerenter", () => {
      this.hovering = true;
      this.show();
    });
    controlsRoot.addEventListener("pointerleave", () => {
      this.hovering = false;
      this.scheduleHide();
    });
  }

  private bindActivity(): void {
    document.addEventListener("pointermove", this.onAnyActivity);
    document.addEventListener("touchstart", this.onAnyActivity, { passive: true });
    document.addEventListener("wheel", this.onAnyActivity, { passive: true });
    document.addEventListener("keydown", this.onKeyDown);
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }
    const { analyser, engine } = this.opts;
    if (e.code === "Space") {
      e.preventDefault();
      void analyser.togglePlay().catch((err) => console.error(err));
      this.show();
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      analyser.seek(analyser.currentTime + 5);
      this.show();
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      analyser.seek(Math.max(0, analyser.currentTime - 5));
      this.show();
      return;
    }
    if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      engine.cycleMode(1);
      this.refreshModeButtons();
      this.show();
    }
  }

  private renderModes(): void {
    const container = this.opts.modesContainer;
    container.replaceChildren();
    const active = this.opts.engine.activeMode;
    for (const mode of this.opts.engine.availableModes) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mode-pill";
      btn.dataset.modeId = mode.id;
      btn.textContent = mode.label;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(mode.id === active));
      btn.addEventListener("click", () => {
        this.opts.engine.setMode(mode.id);
        this.refreshModeButtons();
        this.show();
      });
      container.appendChild(btn);
    }
  }

  private refreshModeButtons(): void {
    const active = this.opts.engine.activeMode;
    const buttons = this.opts.modesContainer.querySelectorAll<HTMLButtonElement>("[data-mode-id]");
    buttons.forEach((btn) => {
      const id = btn.dataset.modeId;
      btn.setAttribute("aria-selected", String(id === active));
    });
  }

  // ---------------------------------------------------------------------------
  // State sync
  // ---------------------------------------------------------------------------

  private onSnapshot(snap: AudioAnalyserSnapshot): void {
    this.lastSnapshot = snap;
    const { app, playBtn, trackLabel, timeTotal, scrubInput } = this.opts;

    app.dataset.state = snap.state;
    playBtn.dataset.state = snap.state === "playing" ? "playing" : "paused";
    playBtn.setAttribute("aria-label", snap.state === "playing" ? "Pause" : "Play");
    trackLabel.textContent = snap.fileName ?? "";
    timeTotal.textContent = formatTime(snap.duration);

    if (!this.seeking) {
      const dur = snap.duration;
      const ratio = dur > 0 ? snap.currentTime / dur : 0;
      const max = Number(scrubInput.max || "1000") || 1000;
      scrubInput.value = String(Math.round(ratio * max));
      this.updateScrubVisual(ratio);
      this.opts.timeCurrent.textContent = formatTime(snap.currentTime);
    }

    if (snap.state === "playing") {
      if (this.rafId === 0) this.startTickLoop();
      this.scheduleHide();
    } else {
      if (this.rafId !== 0) {
        cancelAnimationFrame(this.rafId);
        this.rafId = 0;
      }
      this.show();
    }
  }

  private startTickLoop(): void {
    const tick = (): void => {
      this.rafId = requestAnimationFrame(tick);
      if (this.seeking) return;
      const a = this.opts.analyser;
      const t = a.currentTime;
      const d = a.duration;
      const ratio = d > 0 ? t / d : 0;
      const max = Number(this.opts.scrubInput.max || "1000") || 1000;
      this.opts.scrubInput.value = String(Math.round(ratio * max));
      this.updateScrubVisual(ratio);
      this.opts.timeCurrent.textContent = formatTime(t);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private updateScrubVisual(ratio: number): void {
    const r = Math.max(0, Math.min(1, ratio));
    this.opts.scrubFill.style.transform = `scaleX(${r})`;
    this.opts.scrubHead.style.left = `${(r * 100).toFixed(3)}%`;
  }

  // ---------------------------------------------------------------------------
  // Auto-hide
  // ---------------------------------------------------------------------------

  private show(): void {
    this.opts.app.dataset.controls = "active";
    this.scheduleHide();
  }

  private scheduleHide(): void {
    if (this.hideTimer !== 0) window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), this.hideAfterMs);
  }

  private hide(): void {
    if (this.hovering) return;
    const snap = this.lastSnapshot;
    // Only hide during active playback - paused/ready/idle always stay visible.
    if (!snap || snap.state !== "playing") return;
    this.opts.app.dataset.controls = "idle";
  }
}
