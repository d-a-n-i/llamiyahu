import type { VisualizerMode, VizFrame } from "../types.ts";

/**
 * Tunnel - starfield streaks through layered reactive rings.
 * Bass pulls rings toward the camera; mid twists the warp; treble
 * brightens the star streaks racing past the viewpoint.
 */

interface Star {
  x: number;
  y: number;
  z: number;
  speed: number;
}

const RING_COUNT = 28;
const STAR_COUNT = 90;
const stars: Star[] = [];
let starsReady = false;

function ensureStars(): void {
  if (starsReady) return;
  for (let i = 0; i < STAR_COUNT; i++) {
    stars.push({
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      z: Math.random(),
      speed: 0.18 + Math.random() * 0.55,
    });
  }
  starsReady = true;
}

export const TunnelMode: VisualizerMode = {
  id: "tunnel",
  label: "Tunnel",

  setup(ctx: CanvasRenderingContext2D, frame: VizFrame): void {
    ensureStars();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, frame.width, frame.height);
  },

  draw(ctx: CanvasRenderingContext2D, frame: VizFrame): void {
    ensureStars();
    const {
      width,
      height,
      freqBytes,
      bass,
      mid,
      treble,
      level,
      hueShift,
      time,
      delta,
    } = frame;

    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    ctx.fillRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const minDim = Math.min(width, height);
    const focal = minDim * 0.55;
    const twist = time * (0.35 + mid * 1.4) + bass * 0.8;
    const advance = time * (1.1 + bass * 3.2);
    const starBoost = 0.6 + treble * 2.4 + level * 1.2;

    ctx.lineCap = "round";
    for (const star of stars) {
      star.z -= star.speed * delta * starBoost;
      if (star.z <= 0.02) {
        star.z = 1;
        star.x = (Math.random() - 0.5) * 2;
        star.y = (Math.random() - 0.5) * 2;
        star.speed = 0.18 + Math.random() * 0.55;
      }
      const x1 = cx + (star.x / star.z) * focal;
      const y1 = cy + (star.y / star.z) * focal;
      const zPrev = Math.min(1, star.z + 0.08 * starBoost);
      const x0 = cx + (star.x / zPrev) * focal;
      const y0 = cy + (star.y / zPrev) * focal;
      const alpha = (1 - star.z) * (0.25 + treble * 0.55);
      ctx.strokeStyle = `hsla(${(hueShift + 180) % 360}, 90%, 78%, ${alpha})`;
      ctx.lineWidth = 1 + (1 - star.z) * 2.2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    const spectrumEnd = Math.floor(freqBytes.length * 0.55);
    for (let i = RING_COUNT - 1; i >= 0; i--) {
      const depth = (((i / RING_COUNT + advance * 0.07) % 1) + 1) % 1;
      const z = 0.08 + depth ** 1.35 * 0.92;
      const radius = ((focal * 1.35) / z) * (0.55 + bass * 0.28);
      if (radius > minDim * 1.8) continue;

      const energy =
        freqBytes[Math.min(spectrumEnd - 1, Math.floor((i / RING_COUNT) * spectrumEnd))] /
        255;
      const wobble = 0.04 + energy * 0.14 + bass * 0.06;
      const hue = (hueShift + i * 9 + mid * 40) % 360;
      const alpha = (1 - depth) * (0.35 + energy * 0.55);

      ctx.beginPath();
      for (let s = 0; s <= 48; s++) {
        const ang = (s / 48) * Math.PI * 2 + twist * (1 - depth * 0.6);
        const r = radius * (1 + Math.sin(ang * 6 + time * 3 + i) * wobble);
        const x = cx + Math.cos(ang) * r;
        const y = cy + Math.sin(ang) * r * (0.92 + mid * 0.08);
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(${hue}, 95%, ${50 + energy * 30}%, ${alpha})`;
      ctx.lineWidth = Math.max(1.2, (2.8 - depth * 2) * (0.8 + energy));
      ctx.stroke();
      if (depth < 0.35) {
        ctx.fillStyle = `hsla(${hue}, 100%, 60%, ${alpha * 0.08})`;
        ctx.fill();
      }
    }

    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, minDim * 0.22);
    core.addColorStop(0, `hsla(${hueShift}, 100%, 80%, ${0.18 + bass * 0.4})`);
    core.addColorStop(
      0.5,
      `hsla(${(hueShift + 40) % 360}, 95%, 55%, ${0.06 + mid * 0.1})`,
    );
    core.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = core;
    ctx.fillRect(cx - minDim * 0.25, cy - minDim * 0.25, minDim * 0.5, minDim * 0.5);
  },
};
