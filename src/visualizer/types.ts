/**
 * Shared types for the visualizer engine + individual visual modes.
 *
 * A `VizFrame` is the per-frame snapshot the engine hands to a `VisualizerMode`.
 * The TypedArrays inside are reused across frames - modes must NOT cache them
 * or write back into them.
 */

export interface VizFrame {
  /** FFT magnitudes per bin, 0..255. Reused buffer - do not retain references. */
  readonly freqBytes: Uint8Array;
  /** Waveform samples 0..255 (128 = silence). Reused buffer. */
  readonly waveBytes: Uint8Array;

  /** Canvas dimensions in CSS pixels (already DPR-adjusted via setTransform). */
  readonly width: number;
  readonly height: number;
  readonly dpr: number;

  /** Seconds since engine.start(). */
  readonly time: number;
  /** Seconds since the previous frame. Clamped to <= 0.1s. */
  readonly delta: number;

  /** Temporally smoothed band energy in [0, 1]. */
  readonly bass: number;
  readonly mid: number;
  readonly treble: number;
  /** Overall smoothed loudness in [0, 1]. */
  readonly level: number;

  /** Slowly evolving hue offset (0..360deg). */
  readonly hueShift: number;
}

export interface VisualizerMode {
  readonly id: string;
  readonly label: string;
  /** Optional one-time init when the mode becomes active. */
  setup?(ctx: CanvasRenderingContext2D, frame: VizFrame): void;
  /** Called every animation frame. */
  draw(ctx: CanvasRenderingContext2D, frame: VizFrame): void;
  /** Optional cleanup when the mode is swapped out. */
  teardown?(): void;
}
