import "./style.css";

import { AudioAnalyser } from "./audio/AudioAnalyser.ts";
import { formatTrackLabel } from "./library/archive.ts";
import { VisualizerEngine } from "./visualizer/VisualizerEngine.ts";
import { PulseMode } from "./visualizer/modes/Pulse.ts";
import { BarsMode } from "./visualizer/modes/Bars.ts";
import { WaveMode } from "./visualizer/modes/Wave.ts";
import { TunnelMode } from "./visualizer/modes/Tunnel.ts";
import { KaleidoMode } from "./visualizer/modes/Kaleido.ts";
import { DropZone } from "./ui/DropZone.ts";
import { Controls } from "./ui/Controls.ts";
import { LibraryPanel } from "./ui/LibraryPanel.ts";

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
  const libraryBtn = $<HTMLButtonElement>('[data-action="library"]');
  const playBtn = $<HTMLButtonElement>('[data-action="play"]');
  const controlsRoot = $(".controls");
  const topbar = $('[data-role="trackbar"]');
  const scrubInput = $<HTMLInputElement>('[data-role="scrub-input"]');
  const scrubFill = $('[data-role="scrub-fill"]');
  const scrubHead = $('[data-role="scrub-head"]');
  const timeCurrent = $('[data-role="time-current"]');
  const timeTotal = $('[data-role="time-total"]');
  const dropOverlay = $(".drop-overlay");
  const searchForm = $<HTMLFormElement>('[data-role="search-form"]');

  const analyser = new AudioAnalyser({
    fftSize: 2048,
    smoothingTimeConstant: 0.78,
  });

  const engine = new VisualizerEngine(canvas, analyser);
  engine.registerMode(PulseMode);
  engine.registerMode(BarsMode);
  engine.registerMode(WaveMode);
  engine.registerMode(TunnelMode);
  engine.registerMode(KaleidoMode);

  const closeLibrary = (): void => {
    app.dataset.library = "closed";
  };
  const openLibrary = (): void => {
    app.dataset.library = "open";
  };

  const playRemote = async (url: string, label: string): Promise<void> => {
    await analyser.unlock();
    await analyser.loadUrl(url, label);
    engine.start();
    closeLibrary();
    await analyser.play();
  };

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
        closeLibrary();
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

  const library = new LibraryPanel({
    form: searchForm,
    searchInput: $<HTMLInputElement>('[data-role="search-input"]'),
    searchBtn: $<HTMLButtonElement>('[data-role="search-btn"]'),
    resultsEl: $('[data-role="results"]'),
    statusEl: $('[data-role="search-status"]'),
    onSelect: async (track, playableUrl) => {
      try {
        await playRemote(playableUrl, formatTrackLabel(track));
      } catch (err) {
        console.error("[llamiyahu] failed to play track:", err);
        throw err;
      }
    },
  });
  library.attach();

  const controls = new Controls({
    app,
    controlsRoot,
    topbar,
    playBtn,
    loadBtn,
    libraryBtn,
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
    onRequestLibrary: () => openLibrary(),
  });
  controls.attach();

  const splash = $(".splash");
  splash.addEventListener("click", (e) => {
    if (e.target !== splash) return;
    if (analyser.state === "idle" || analyser.state === "loading") return;
    closeLibrary();
  });

  // Defensive: stop iOS double-tap zoom on the canvas itself. The engine
  // already calls preventDefault on touch events, but a synthetic click
  // from a double-tap can still fire - swallow it on the bare canvas.
  canvas.addEventListener("dblclick", (e) => e.preventDefault());

  // Tear down cleanly on page unload so the AudioContext is closed.
  window.addEventListener("beforeunload", () => {
    controls.detach();
    library.detach();
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
