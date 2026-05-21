import type { AudioAnalyser } from "../audio/AudioAnalyser.ts";
import type { VisualizerMode, VizFrame } from "./types.ts";

/**
 * VisualizerEngine
 * -----------------------------------------------------------------------------
 * Owns the rendering loop, the canvas resize logic, frequency-band smoothing,
 * and the active visualization mode. Modes are pure functions of a VizFrame so
 * switching is instant and side-effect free.
 *
 * The engine reads FFT data from a shared AudioAnalyser - it never owns the
 * audio graph itself.
 */

export interface ModeInfo {
  readonly id: string;
  readonly label: string;
}

export class VisualizerEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly analyser: AudioAnalyser;

  private readonly modes: Map<string, VisualizerMode> = new Map();
  private readonly order: string[] = [];
  private activeId: string | null = null;

  private running = false;
  private rafId = 0;
  private startTs = 0;
  private lastTs = 0;

  private widthCss = 0;
  private heightCss = 0;
  private dpr = 1;

  private smBass = 0;
  private smMid = 0;
  private smTreble = 0;
  private smLevel = 0;
  private hueShift = 0;

  private resizeObserver: ResizeObserver | null = null;
  private readonly windowResize = (): void => this.resize();
  private readonly touchBlock = (e: TouchEvent): void => {
    // Mobile guardrail: stop pinch-zoom / scroll-while-dragging on the canvas.
    if (e.cancelable) e.preventDefault();
  };

  constructor(canvas: HTMLCanvasElement, analyser: AudioAnalyser) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      throw new Error("Could not acquire 2D context for visualizer canvas.");
    }
    this.canvas = canvas;
    this.ctx = ctx;
    this.analyser = analyser;

    canvas.addEventListener("touchstart", this.touchBlock, { passive: false });
    canvas.addEventListener("touchmove", this.touchBlock, { passive: false });
    canvas.addEventListener("touchend", this.touchBlock, { passive: false });

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    } else {
      window.addEventListener("resize", this.windowResize);
    }
    this.resize();
  }

  // ---------------------------------------------------------------------------
  // Mode management
  // ---------------------------------------------------------------------------

  registerMode(mode: VisualizerMode): void {
    if (this.modes.has(mode.id)) return;
    this.modes.set(mode.id, mode);
    this.order.push(mode.id);
    if (this.activeId === null) {
      this.activeId = mode.id;
    }
  }

  setMode(id: string): void {
    const next = this.modes.get(id);
    if (!next) return;
    const prevId = this.activeId;
    if (prevId === id) return;
    if (prevId) {
      const prev = this.modes.get(prevId);
      if (prev && prev.teardown) prev.teardown();
    }
    this.activeId = id;
    if (next.setup) next.setup(this.ctx, this.makeFrame(0, 0));
  }

  cycleMode(direction: 1 | -1 = 1): string | null {
    if (this.order.length === 0) return null;
    const idx = this.activeId ? this.order.indexOf(this.activeId) : -1;
    const nextIdx = (idx + direction + this.order.length) % this.order.length;
    const id = this.order[nextIdx];
    this.setMode(id);
    return id;
  }

  get availableModes(): ModeInfo[] {
    const out: ModeInfo[] = [];
    for (const id of this.order) {
      const m = this.modes.get(id);
      if (m) out.push({ id: m.id, label: m.label });
    }
    return out;
  }

  get activeMode(): string | null {
    return this.activeId;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startTs = 0;
    this.lastTs = 0;
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  dispose(): void {
    this.stop();
    this.canvas.removeEventListener("touchstart", this.touchBlock);
    this.canvas.removeEventListener("touchmove", this.touchBlock);
    this.canvas.removeEventListener("touchend", this.touchBlock);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    } else {
      window.removeEventListener("resize", this.windowResize);
    }
    for (const id of this.order) {
      const m = this.modes.get(id);
      if (m && m.teardown) m.teardown();
    }
    this.modes.clear();
    this.order.length = 0;
    this.activeId = null;
  }

  // ---------------------------------------------------------------------------
  // Internal: render loop
  // ---------------------------------------------------------------------------

  private readonly loop = (ts: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const tsSec = ts / 1000;
    if (this.startTs === 0) {
      this.startTs = tsSec;
      this.lastTs = tsSec;
    }
    const delta = Math.min(Math.max(tsSec - this.lastTs, 0), 0.1);
    const time = tsSec - this.startTs;
    this.lastTs = tsSec;

    const frame = this.makeFrame(time, delta);

    const mode = this.activeId ? this.modes.get(this.activeId) : undefined;
    if (mode) {
      mode.draw(this.ctx, frame);
    } else {
      this.ctx.fillStyle = "#000";
      this.ctx.fillRect(0, 0, frame.width, frame.height);
    }
  };

  private makeFrame(time: number, delta: number): VizFrame {
    const freq = this.analyser.getFrequencyData();
    const wave = this.analyser.getTimeDomainData();
    this.updateBands(freq, delta);

    return {
      freqBytes: freq,
      waveBytes: wave,
      width: this.widthCss,
      height: this.heightCss,
      dpr: this.dpr,
      time,
      delta,
      bass: this.smBass,
      mid: this.smMid,
      treble: this.smTreble,
      level: this.smLevel,
      hueShift: this.hueShift,
    };
  }

  private updateBands(freq: Uint8Array, delta: number): void {
    const N = freq.length;
    if (N === 0) return;

    // Bin boundaries chosen for a 2048 FFT at typical 44.1/48 kHz.
    const bassEnd = Math.max(2, Math.floor(N * 0.04));
    const midEnd = Math.max(bassEnd + 1, Math.floor(N * 0.2));
    const trebleEnd = Math.max(midEnd + 1, Math.floor(N * 0.85));

    let bs = 0;
    let ms = 0;
    let tr = 0;
    let lv = 0;
    for (let i = 1; i < bassEnd; i++) bs += freq[i];
    for (let i = bassEnd; i < midEnd; i++) ms += freq[i];
    for (let i = midEnd; i < trebleEnd; i++) tr += freq[i];
    for (let i = 1; i < N; i++) lv += freq[i];

    const bass = bs / (bassEnd - 1) / 255;
    const mid = ms / (midEnd - bassEnd) / 255;
    const treble = tr / (trebleEnd - midEnd) / 255;
    const level = lv / (N - 1) / 255;

    // Time-correct exponential smoothing (frame-rate independent).
    const k = (tau: number): number => 1 - Math.exp(-delta / tau);
    this.smBass += (bass - this.smBass) * k(0.08);
    this.smMid += (mid - this.smMid) * k(0.12);
    this.smTreble += (treble - this.smTreble) * k(0.16);
    this.smLevel += (level - this.smLevel) * k(0.1);

    // Hue: 8 deg/sec baseline + bass-driven kick. Wraps in [0, 360).
    this.hueShift = (this.hueShift + delta * 8 + this.smBass * delta * 28) % 360;
  }

  // ---------------------------------------------------------------------------
  // Internal: sizing
  // ---------------------------------------------------------------------------

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const pxW = Math.max(1, Math.round(w * dpr));
    const pxH = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== pxW) this.canvas.width = pxW;
    if (this.canvas.height !== pxH) this.canvas.height = pxH;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.widthCss = w;
    this.heightCss = h;
    this.dpr = dpr;
    // Clear so the previous frame at the old size doesn't streak.
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, w, h);
  }
}
