/**
 * AudioAnalyser
 * -----------------------------------------------------------------------------
 * Owns the entire Web Audio graph for llamiyahu.
 *
 * Graph:  AudioBufferSourceNode --> GainNode --> AnalyserNode --> destination
 *
 * Responsibilities:
 *   1. Lazily create the AudioContext (must be triggered from a user gesture
 *      to satisfy browser autoplay / audio-unlock policies).
 *   2. Decode local .mp3 / .wav / .ogg files (or remote URLs) into an
 *      AudioBuffer using `decodeAudioData`.
 *   3. Manage playback (play / pause / seek / stop) on top of the single-use
 *      AudioBufferSourceNode, transparently re-creating the node as needed.
 *   4. Expose reusable Uint8Array / Float32Array buffers with the latest FFT
 *      and waveform samples so the visualizer can read them once per
 *      requestAnimationFrame tick with zero per-frame allocations.
 *   5. Provide a minimal subscribe() observer so the controls UI can react
 *      to state changes without polling.
 */

export type PlayerState =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "ended";

export interface AudioAnalyserSnapshot {
  readonly state: PlayerState;
  readonly duration: number;
  readonly currentTime: number;
  readonly fileName: string | null;
  readonly error: string | null;
  /** 0..1 while loading; null when idle / ready / playing. */
  readonly loadProgress: number | null;
}

export type AudioAnalyserListener = (snapshot: AudioAnalyserSnapshot) => void;

export interface AudioAnalyserOptions {
  /** Power-of-two FFT window size. Larger = finer freq resolution, slower. */
  fftSize?: number;
  /** 0..1 temporal smoothing applied to FFT magnitudes between frames. */
  smoothingTimeConstant?: number;
  /** Lower bound (dB) of FFT magnitude scaling. */
  minDecibels?: number;
  /** Upper bound (dB) of FFT magnitude scaling. */
  maxDecibels?: number;
  /** Initial gain on a 0..1 linear scale. */
  initialVolume?: number;
}

const DEFAULT_FFT_SIZE = 2048;
const DEFAULT_SMOOTHING = 0.8;
const DEFAULT_MIN_DB = -90;
const DEFAULT_MAX_DB = -10;
const DEFAULT_VOLUME = 1;

export class AudioAnalyser {
  // --- Web Audio graph ---
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private gainNode: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;

  // --- Reused sample buffers (allocated once after the AnalyserNode exists) ---
  // (Generic parameter inferred from `new Uint8Array(...)` so AnalyserNode's
  // typed-array signatures - which require `<ArrayBuffer>` in TS 5.7+ - line up.)
  private frequencyBytes = new Uint8Array(0);
  private timeDomainBytes = new Uint8Array(0);
  private frequencyFloats = new Float32Array(0);
  private timeDomainFloats = new Float32Array(0);

  // --- Playback timing ---
  // `startedAt` is the AudioContext time at which the current source was
  // conceptually started from offset=0 (i.e. ctx.currentTime - playbackOffset).
  // `pausedAt`  is the offset (in seconds) inside the buffer at which we are
  // paused. While playing, currentTime = ctx.currentTime - startedAt.
  private startedAt = 0;
  private pausedAt = 0;

  // --- State ---
  private playerState: PlayerState = "idle";
  private fileName: string | null = null;
  private lastError: string | null = null;
  private loadProgress: number | null = null;
  private loadSeq = 0;

  // --- Config ---
  private readonly fftSize: number;
  private readonly smoothingTimeConstant: number;
  private readonly minDecibels: number;
  private readonly maxDecibels: number;
  private readonly initialVolume: number;

  // --- Observers ---
  private readonly listeners: Set<AudioAnalyserListener> = new Set();

  constructor(options: AudioAnalyserOptions = {}) {
    this.fftSize = options.fftSize ?? DEFAULT_FFT_SIZE;
    this.smoothingTimeConstant =
      options.smoothingTimeConstant ?? DEFAULT_SMOOTHING;
    this.minDecibels = options.minDecibels ?? DEFAULT_MIN_DB;
    this.maxDecibels = options.maxDecibels ?? DEFAULT_MAX_DB;
    this.initialVolume = options.initialVolume ?? DEFAULT_VOLUME;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle / gesture unlock
  // ---------------------------------------------------------------------------

  /**
   * Must be called from inside a user-gesture event handler (pointerdown,
   * touchstart, keydown). Creates the AudioContext if needed and resumes it
   * if the browser left it suspended.
   */
  async unlock(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
  }

  /** True once the AudioContext exists and is running. */
  get isUnlocked(): boolean {
    return this.context !== null && this.context.state === "running";
  }

  /**
   * Ensure the AudioContext exists (call from a user gesture) and return it.
   * Used by Archive search probes that need decodeAudioData.
   */
  async getContext(): Promise<AudioContext> {
    await this.unlock();
    return this.ensureContext();
  }

  private ensureContext(): AudioContext {
    if (this.context && this.analyser && this.gainNode) {
      return this.context;
    }

    const Ctor: typeof AudioContext | undefined = window.AudioContext;
    if (!Ctor) {
      const message = "Web Audio API is not supported in this browser.";
      this.lastError = message;
      throw new Error(message);
    }

    const ctx = new Ctor();

    const analyser = ctx.createAnalyser();
    analyser.fftSize = this.fftSize;
    analyser.smoothingTimeConstant = this.smoothingTimeConstant;
    analyser.minDecibels = this.minDecibels;
    analyser.maxDecibels = this.maxDecibels;

    const gain = ctx.createGain();
    gain.gain.value = this.initialVolume;

    // Routing is fixed: gain feeds the analyser, the analyser feeds the
    // speakers. Source nodes get attached to `gain` each time we (re)play.
    gain.connect(analyser);
    analyser.connect(ctx.destination);

    this.context = ctx;
    this.analyser = analyser;
    this.gainNode = gain;

    this.frequencyBytes = new Uint8Array(analyser.frequencyBinCount);
    this.timeDomainBytes = new Uint8Array(analyser.fftSize);
    this.frequencyFloats = new Float32Array(analyser.frequencyBinCount);
    this.timeDomainFloats = new Float32Array(analyser.fftSize);

    return ctx;
  }

  // ---------------------------------------------------------------------------
  // File ingestion
  // ---------------------------------------------------------------------------

  /** Load a File or Blob (typically from <input type="file"> or drag-and-drop). */
  async loadFile(file: File | Blob): Promise<void> {
    if (!file) {
      throw new Error("No file provided.");
    }
    const name = "name" in file ? file.name : "audio";
    const seq = ++this.loadSeq;
    this.fileName = name;
    this.lastError = null;
    this.setProgress(0);
    this.setState("loading");
    try {
      const data = await this.readBlobWithProgress(file, (ratio) => {
        if (seq !== this.loadSeq) return;
        // Reserve the top ~12% of the bar for decode.
        this.setProgress(ratio * 0.88);
      });
      if (seq !== this.loadSeq) return;
      await this.decodeAndAdopt(data, seq);
    } catch (err) {
      if (seq !== this.loadSeq) return;
      this.lastError = this.friendlyError(
        err instanceof Error ? err.message : "Failed to load audio file.",
      );
      this.setProgress(null);
      this.setState("idle");
      throw new Error(this.lastError);
    }
  }

  /**
   * Load audio from a URL (same-origin or properly CORS-enabled).
   * Optional `displayName` is shown in the track label / controls.
   */
  async loadUrl(url: string, displayName?: string): Promise<void> {
    const seq = ++this.loadSeq;
    this.fileName = displayName ?? url.split("/").pop() ?? url;
    this.lastError = null;
    this.setProgress(0);
    this.setState("loading");
    try {
      const res = await fetch(url, { mode: "cors", credentials: "omit" });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new Error("This file is restricted — try another result.");
        }
        throw new Error(`Failed to fetch audio (${res.status}).`);
      }
      const data = await this.readResponseWithProgress(res, (ratio) => {
        if (seq !== this.loadSeq) return;
        this.setProgress(ratio * 0.88);
      });
      if (seq !== this.loadSeq) return;
      await this.decodeAndAdopt(data, seq);
    } catch (err) {
      if (seq !== this.loadSeq) return;
      const raw = err instanceof Error ? err.message : "Failed to load audio url.";
      // Browsers surface CORS / network failures as the opaque "Failed to fetch".
      this.lastError = this.friendlyError(raw);
      this.setProgress(null);
      this.setState("idle");
      throw new Error(this.lastError);
    }
  }

  private friendlyError(raw: string): string {
    if (/failed to fetch|networkerror|load failed/i.test(raw)) {
      return "Could not download audio (CORS or network). Try another result or upload a file.";
    }
    if (/unable to decode|encoding error|decodeaudio|not supported/i.test(raw)) {
      return "Couldn't decode this audio — try another result or upload an MP3/WAV.";
    }
    return raw;
  }

  private async readBlobWithProgress(
    file: Blob,
    onProgress: (ratio: number) => void,
  ): Promise<ArrayBuffer> {
    // Small files: one-shot read is fine.
    if (file.size <= 256 * 1024 || typeof file.stream !== "function") {
      onProgress(1);
      return file.arrayBuffer();
    }
    return this.readStreamWithProgress(file.stream(), file.size, onProgress);
  }

  private async readResponseWithProgress(
    res: Response,
    onProgress: (ratio: number) => void,
  ): Promise<ArrayBuffer> {
    const total = Number(res.headers.get("content-length"));
    if (!res.body || !Number.isFinite(total) || total <= 0) {
      const data = await res.arrayBuffer();
      onProgress(1);
      return data;
    }
    return this.readStreamWithProgress(res.body, total, onProgress);
  }

  private async readStreamWithProgress(
    stream: ReadableStream<Uint8Array>,
    total: number,
    onProgress: (ratio: number) => void,
  ): Promise<ArrayBuffer> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    onProgress(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        chunks.push(value);
        received += value.byteLength;
        onProgress(Math.min(1, received / total));
      }
    }
    onProgress(1);
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer;
  }

  private async decodeAndAdopt(data: ArrayBuffer, seq: number): Promise<void> {
    const ctx = this.ensureContext();
    this.stopSource();
    this.setProgress(0.9);
    // `decodeAudioData` detaches the input buffer on some browsers, so we
    // hand it a private copy. This also lets the caller hold on to `data`.
    const copy = data.slice(0);
    let decoded: AudioBuffer;
    try {
      decoded = await ctx.decodeAudioData(copy);
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Unable to decode audio data";
      throw new Error(raw);
    }
    if (seq !== this.loadSeq) return;
    this.buffer = decoded;
    this.pausedAt = 0;
    this.startedAt = 0;
    this.setProgress(1);
    this.setState("ready");
    this.setProgress(null);
  }

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  async play(): Promise<void> {
    if (!this.buffer) return;
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    if (this.playerState === "playing") return;

    // Restart from the end if we previously ran past the buffer.
    const offset =
      this.pausedAt >= this.buffer.duration ? 0 : this.pausedAt;

    this.startSource(offset);
    this.startedAt = ctx.currentTime - offset;
    this.setState("playing");
  }

  pause(): void {
    if (this.playerState !== "playing") return;
    const ctx = this.context;
    if (!ctx) return;
    this.pausedAt = Math.max(0, ctx.currentTime - this.startedAt);
    this.stopSource();
    this.setState("paused");
  }

  async togglePlay(): Promise<void> {
    if (this.playerState === "playing") {
      this.pause();
      return;
    }
    await this.play();
  }

  /** Stop playback completely and rewind to the start of the buffer. */
  stop(): void {
    this.stopSource();
    this.pausedAt = 0;
    this.startedAt = 0;
    this.setState(this.buffer ? "ready" : "idle");
  }

  /** Seek to an absolute position (seconds). Preserves play/pause state. */
  seek(time: number): void {
    if (!this.buffer) return;
    const clamped = Math.max(0, Math.min(time, this.buffer.duration));
    const wasPlaying = this.playerState === "playing";
    this.stopSource();
    this.pausedAt = clamped;
    if (wasPlaying) {
      const ctx = this.ensureContext();
      this.startSource(clamped);
      this.startedAt = ctx.currentTime - clamped;
      this.setState("playing");
    } else {
      // No state transition, but the timeline UI still needs the new currentTime.
      this.notify();
    }
  }

  /** Set linear volume in [0, 1]. */
  setVolume(value: number): void {
    if (!this.gainNode) return;
    const v = Math.max(0, Math.min(1, value));
    this.gainNode.gain.value = v;
  }

  // ---------------------------------------------------------------------------
  // Source-node management (private)
  // ---------------------------------------------------------------------------

  private startSource(offset: number): void {
    if (!this.context || !this.buffer || !this.gainNode) return;
    const src = this.context.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gainNode);
    src.onended = () => this.handleNaturalEnd(src);
    src.start(0, offset);
    this.source = src;
  }

  private stopSource(): void {
    const src = this.source;
    if (!src) return;
    // Detach the source before stopping so onended doesn't fire as "ended".
    this.source = null;
    src.onended = null;
    try {
      src.stop(0);
    } catch {
      // Source was never started or already stopped - safe to ignore.
    }
    try {
      src.disconnect();
    } catch {
      // Already disconnected - safe to ignore.
    }
  }

  private handleNaturalEnd(src: AudioBufferSourceNode): void {
    // Only fires when the source actually ran out of audio - manual stops
    // null out `this.source` and `onended` before calling stop().
    if (this.source !== src) return;
    this.source = null;
    this.pausedAt = 0;
    this.startedAt = 0;
    this.setState("ended");
  }

  // ---------------------------------------------------------------------------
  // FFT / waveform data extraction
  // (Each getter writes into a reused TypedArray - zero allocations per frame.)
  // ---------------------------------------------------------------------------

  /** Magnitudes per FFT bin in [0, 255]. Returned buffer is reused. */
  getFrequencyData(): Uint8Array {
    if (!this.analyser) return this.frequencyBytes;
    this.analyser.getByteFrequencyData(this.frequencyBytes);
    return this.frequencyBytes;
  }

  /** Waveform samples in [0, 255] (128 = silence). Returned buffer is reused. */
  getTimeDomainData(): Uint8Array {
    if (!this.analyser) return this.timeDomainBytes;
    this.analyser.getByteTimeDomainData(this.timeDomainBytes);
    return this.timeDomainBytes;
  }

  /** Magnitudes per FFT bin in dB (Float32). Returned buffer is reused. */
  getFloatFrequencyData(): Float32Array {
    if (!this.analyser) return this.frequencyFloats;
    this.analyser.getFloatFrequencyData(this.frequencyFloats);
    return this.frequencyFloats;
  }

  /** Waveform samples in [-1, 1] (Float32). Returned buffer is reused. */
  getFloatTimeDomainData(): Float32Array {
    if (!this.analyser) return this.timeDomainFloats;
    this.analyser.getFloatTimeDomainData(this.timeDomainFloats);
    return this.timeDomainFloats;
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  get state(): PlayerState {
    return this.playerState;
  }

  get duration(): number {
    return this.buffer ? this.buffer.duration : 0;
  }

  get currentTime(): number {
    if (this.playerState === "playing" && this.context) {
      const t = this.context.currentTime - this.startedAt;
      return Math.max(0, Math.min(t, this.duration));
    }
    return this.pausedAt;
  }

  get currentFileName(): string | null {
    return this.fileName;
  }

  get binCount(): number {
    return this.analyser ? this.analyser.frequencyBinCount : 0;
  }

  get sampleRate(): number {
    return this.context ? this.context.sampleRate : 0;
  }

  /** Exposed so advanced visualizer modes can read additional analyser metadata. */
  get analyserNode(): AnalyserNode | null {
    return this.analyser;
  }

  snapshot(): AudioAnalyserSnapshot {
    return {
      state: this.playerState,
      duration: this.duration,
      currentTime: this.currentTime,
      fileName: this.fileName,
      error: this.lastError,
      loadProgress: this.loadProgress,
    };
  }

  private setProgress(value: number | null): void {
    const next =
      value == null ? null : Math.max(0, Math.min(1, value));
    if (this.loadProgress === next) {
      // Still notify so UI can refresh during long downloads with unchanged
      // rounded values at the endpoints.
      if (next === 0 || next === 1) this.notify();
      return;
    }
    this.loadProgress = next;
    this.notify();
  }

  // ---------------------------------------------------------------------------
  // Observer API
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to state changes (load / play / pause / seek / ended / error).
   * The listener is invoked once synchronously with the current snapshot, and
   * then on every subsequent state transition. Returns an unsubscribe handle.
   */
  subscribe(listener: AudioAnalyserListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snap = this.snapshot();
    // Copy first so a listener that unsubscribes itself during iteration
    // doesn't perturb the active iteration order.
    const current = Array.from(this.listeners);
    for (const listener of current) {
      listener(snap);
    }
  }

  private setState(next: PlayerState): void {
    if (this.playerState === next) {
      // Position may still have changed (e.g. seek while paused) - notify anyway.
      this.notify();
      return;
    }
    this.playerState = next;
    this.notify();
  }

  // ---------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------

  async dispose(): Promise<void> {
    this.stopSource();
    this.listeners.clear();
    this.buffer = null;

    if (this.gainNode) {
      try {
        this.gainNode.disconnect();
      } catch {
        // ignore
      }
    }
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch {
        // ignore
      }
    }

    const ctx = this.context;
    this.context = null;
    this.analyser = null;
    this.gainNode = null;

    if (ctx && ctx.state !== "closed") {
      try {
        await ctx.close();
      } catch {
        // ignore
      }
    }
  }
}
