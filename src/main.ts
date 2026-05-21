import "./style.css";

import { AudioAnalyser } from "./audio/AudioAnalyser.ts";
import { VisualizerEngine } from "./visualizer/VisualizerEngine.ts";
import { PulseMode } from "./visualizer/modes/Pulse.ts";
import { BarsMode } from "./visualizer/modes/Bars.ts";
import { WaveMode } from "./visualizer/modes/Wave.ts";
import { DropZone } from "./ui/DropZone.ts";
import { Controls } from "./ui/Controls.ts";

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`llamiyahu: missing required element "${selector}"`);
  return el;
}

function boot(): void {
  const app = $("#app");
  const canvas = $<HTMLCanvasElement>("#stage");
  const fileInput = $<HTMLInputElement>("#file-input");
  const splashBtn = $<HTMLButtonElement>('[data-action="splash-pick"]');
  const loadBtn = $<HTMLButtonElement>('[data-action="load"]');
  const playBtn = $<HTMLButtonElement>('[data-action="play"]');
  const controlsRoot = $(".controls");
  const topbar = $('[data-role="trackbar"]');
  const scrubInput = $<HTMLInputElement>('[data-role="scrub-input"]');
  const scrubFill = $('[data-role="scrub-fill"]');
  const scrubHead = $('[data-role="scrub-head"]');
  const timeCurrent = $('[data-role="time-current"]');
  const timeTotal = $('[data-role="time-total"]');
  const dropOverlay = $(".drop-overlay");

  const analyser = new AudioAnalyser({
    fftSize: 2048,
    smoothingTimeConstant: 0.78,
  });

  const engine = new VisualizerEngine(canvas, analyser);
  engine.registerMode(PulseMode);
  engine.registerMode(BarsMode);
  engine.registerMode(WaveMode);

  const dropzone = new DropZone({
    root: app,
    overlay: dropOverlay,
    fileInput,
    onFile: async (file: File): Promise<void> => {
      try {
        // The picker / drop callback runs synchronously inside a user gesture,
        // so resuming the AudioContext here satisfies autoplay policy.
        await analyser.unlock();
        await analyser.loadFile(file);
        engine.start();
        await analyser.play();
      } catch (err) {
        console.error("[llamiyahu] failed to load file:", err);
      }
    },
  });
  dropzone.attach();

  // Splash button: pre-emptively unlock the context (still a user gesture)
  // then open the picker.
  splashBtn.addEventListener("click", () => {
    void analyser.unlock().catch(() => {
      /* surfaced via snapshot.error */
    });
    dropzone.openPicker();
  });

  const controls = new Controls({
    app,
    controlsRoot,
    topbar,
    playBtn,
    loadBtn,
    modesContainer: $(".modes"),
    scrubInput,
    scrubFill,
    scrubHead,
    timeCurrent,
    timeTotal,
    trackLabel: topbar,
    analyser,
    engine,
    onRequestLoad: () => dropzone.openPicker(),
  });
  controls.attach();

  // Defensive: stop iOS double-tap zoom on the canvas itself. The engine
  // already calls preventDefault on touch events, but a synthetic click
  // from a double-tap can still fire - swallow it on the bare canvas.
  canvas.addEventListener("dblclick", (e) => e.preventDefault());

  // Tear down cleanly on page unload so the AudioContext is closed.
  window.addEventListener("beforeunload", () => {
    controls.detach();
    dropzone.detach();
    engine.dispose();
    void analyser.dispose();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
