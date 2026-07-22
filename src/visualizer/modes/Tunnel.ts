import type { VisualizerMode, VizFrame } from "../types.ts";

/**
 * Tunnel — hyperspace ring tunnel (MilkDrop / WMP classic energy).
 * Perspective rings rush toward the camera; bass widens the mouth,
 * treble seeds star streaks, and mid shifts the hue of the walls.
 */

const RING_COUNT = 28;
const STAR_COUNT = 90;

interface Star {
  x: number;
  y: number;
  z: number;
  speed: number;
}

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
    const fov = minDim * 0.55;
    const twist = time * (0.35 + mid * 1.4) + bass * 0.8;
    const rush = time * (1.1 + bass * 3.2);

    // ---- Star streaks ---------------------------------------------------
    const starBoost = 0.6 + treble * 2.4 + level * 1.2;
    ctx.lineCap = "round";
    for (const s of stars) {
      s.z -= s.speed * delta * starBoost;
      if (s.z <= 0.02) {
        s.z = 1;
        s.x = (Math.random() - 0.5) * 2;
        s.y = (Math.random() - 0.5) * 2;
        s.speed = 0.18 + Math.random() * 0.55;
      }
      const sx = cx + (s.x / s.z) * fov;
      const sy = cy + (s.y / s.z) * fov;
      const px = cx + (s.x / Math.min(1, s.z + 0.08 * starBoost)) * fov;
      const py = cy + (s.y / Math.min(1, s.z + 0.08 * starBoost)) * fov;
      const a = (1 - s.z) * (0.25 + treble * 0.55);
      ctx.strokeStyle = `hsla(${(hueShift + 180) % 360}, 90%, 78%, ${a})`;
      ctx.lineWidth = 1 + (1 - s.z) * 2.2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(sx, sy);
      ctx.stroke();
    }

    // ---- Perspective rings ----------------------------------------------
    const usable = Math.floor(freqBytes.length * 0.55);
    for (let i = RING_COUNT - 1; i >= 0; i--) {
      const t = ((i / RING_COUNT + rush * 0.07) % 1 + 1) % 1;
      // Near camera = large; far = small, with easing for depth.
      const depth = 0.08 + Math.pow(t, 1.35) * 0.92;
      const radius = (fov * 1.35) / depth * (0.55 + bass * 0.28);
      if (radius > minDim * 1.8) continue;

      const bin = Math.min(
        usable - 1,
        Math.floor((i / RING_COUNT) * usable),
      );
      const energy = freqBytes[bin] / 255;
      const sides = 48;
      const wobble = 0.04 + energy * 0.14 + bass * 0.06;
      const ringHue = (hueShift + i * 9 + mid * 40) % 360;
      const alpha = (1 - t) * (0.35 + energy * 0.55);

      ctx.beginPath();
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2 + twist * (1 - t * 0.6);
        const pulse = 1 + Math.sin(a * 6 + time * 3 + i) * wobble;
        const r = radius * pulse;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r * (0.92 + mid * 0.08);
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(${ringHue}, 95%, ${50 + energy * 30}%, ${alpha})`;
      ctx.lineWidth = Math.max(1.2, (2.8 - t * 2) * (0.8 + energy));
      ctx.stroke();

      // Soft inner fill on near rings for bloom.
      if (t < 0.35) {
        ctx.fillStyle = `hsla(${ringHue}, 100%, 60%, ${alpha * 0.08})`;
        ctx.fill();
      }
    }

    // ---- Central vanishing glow ----------------------------------------
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, minDim * 0.22);
    core.addColorStop(0, `hsla(${hueShift}, 100%, 80%, ${0.18 + bass * 0.4})`);
    core.addColorStop(0.5, `hsla(${(hueShift + 40) % 360}, 95%, 55%, ${0.06 + mid * 0.1})`);
    core.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = core;
    ctx.fillRect(cx - minDim * 0.25, cy - minDim * 0.25, minDim * 0.5, minDim * 0.5);
  },
};
