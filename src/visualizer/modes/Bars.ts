import type { VisualizerMode, VizFrame } from "../types.ts";

/**
 * Bars - centred, log-spaced frequency spectrum, mirrored vertically.
 * Each bar gets a vertical gradient that shifts hue with both its bin index
 * and the global hue cycle, so the spectrum reads as a smooth aurora.
 */

const BAR_COUNT = 84;

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

export const BarsMode: VisualizerMode = {
  id: "bars",
  label: "Bars",

  setup(ctx: CanvasRenderingContext2D, frame: VizFrame): void {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, frame.width, frame.height);
  },

  draw(ctx: CanvasRenderingContext2D, frame: VizFrame): void {
    const { width, height, freqBytes, bass, hueShift } = frame;

    // Strong clear (no trails for this mode - cleaner read).
    ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
    ctx.fillRect(0, 0, width, height);

    const cy = height / 2;
    const maxHalfHeight = height * 0.42;
    const sideMargin = Math.max(24, width * 0.05);
    const innerW = width - sideMargin * 2;
    const gap = Math.max(2, Math.min(6, innerW / BAR_COUNT / 6));
    const barW = (innerW - gap * (BAR_COUNT - 1)) / BAR_COUNT;
    const startX = sideMargin;

    // Skip the very top of the FFT (it's mostly silence for music).
    const usableBins = Math.floor(freqBytes.length * 0.75);

    for (let i = 0; i < BAR_COUNT; i++) {
      // Log-ish bin mapping so the visible spectrum looks more musical.
      const t0 = i / BAR_COUNT;
      const t1 = (i + 1) / BAR_COUNT;
      const lo = Math.floor(Math.pow(t0, 1.4) * usableBins);
      const hi = Math.max(lo + 1, Math.floor(Math.pow(t1, 1.4) * usableBins));

      let sum = 0;
      for (let k = lo; k < hi; k++) sum += freqBytes[k];
      const v = sum / (hi - lo) / 255;

      const halfH = v * maxHalfHeight;
      const x = startX + i * (barW + gap);

      const hue = (hueShift + i * 2.4 + bass * 25) % 360;
      const grad = ctx.createLinearGradient(0, cy - halfH, 0, cy + halfH);
      grad.addColorStop(0, `hsla(${hue}, 95%, ${60 + v * 20}%, 0.95)`);
      grad.addColorStop(0.5, `hsla(${(hue + 50) % 360}, 95%, 60%, 0.85)`);
      grad.addColorStop(1, `hsla(${(hue + 100) % 360}, 95%, ${55 + v * 15}%, 0.95)`);
      ctx.fillStyle = grad;

      const radius = Math.min(barW / 2, 5);
      roundRectPath(ctx, x, cy - halfH, barW, halfH * 2, radius);
      ctx.fill();
    }

    // Centre line - a thin highlight that pulses with bass.
    ctx.fillStyle = `rgba(255, 255, 255, ${0.05 + bass * 0.18})`;
    ctx.fillRect(sideMargin, cy - 0.5, innerW, 1);
  },
};
