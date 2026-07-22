import "./style.css";

import { AudioAnalyser } from "./audio/AudioAnalyser.ts";
import { VisualizerEngine } from "./visualizer/VisualizerEngine.ts";
import { PulseMode } from "./visualizer/modes/Pulse.ts";
import { BarsMode } from "./visualizer/modes/Bars.ts";
import { WaveMode } from "./visualizer/modes/Wave.ts";
import { TunnelMode } from "./visualizer/modes/Tunnel.ts";
import { KaleidoMode } from "./visualizer/modes/Kaleido.ts";
import { DropZone } from "./ui/DropZone.ts";
import { Controls } from "./ui/Controls.ts";
import { MusicBrowser } from "./ui/MusicBrowser.ts";
import { displayName, type TrackRef } from "./music/library.ts";

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

  const playFromUrl = async (url: string, label: string): Promise<void> => {
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

  splashBtn.addEventListener("click", () => {
    void analyser.unlock().catch(() => {
      /* surfaced via snapshot.error */
    });
    dropzone.openPicker();
  });

  const browser = new MusicBrowser({
    form: searchForm,
    searchInput: $<HTMLInputElement>('[data-role="search-input"]'),
    searchBtn: $<HTMLButtonElement>('[data-role="search-btn"]'),
    resultsEl: $('[data-role="results"]'),
    featuredEl: $('[data-role="featured"]'),
    statusEl: $('[data-role="search-status"]'),
    onSelect: async (track: TrackRef, playableUrl: string): Promise<void> => {
      try {
        await playFromUrl(playableUrl, displayName(track));
      } catch (err) {
        console.error("[llamiyahu] failed to play track:", err);
        throw err;
      }
    },
  });
  browser.attach();

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

  // Clicking the dimmed backdrop (outside splash__inner) closes the library
  // when audio is already loaded.
  const splash = $(".splash");
  splash.addEventListener("click", (e) => {
    if (e.target !== splash) return;
    if (analyser.state === "idle" || analyser.state === "loading") return;
    closeLibrary();
  });

  canvas.addEventListener("dblclick", (e) => e.preventDefault());

  window.addEventListener("beforeunload", () => {
    controls.detach();
    browser.detach();
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
