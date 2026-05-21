import type { VisualizerMode, VizFrame } from "../types.ts";

/**
 * Pulse - radial spectrum + circular waveform with a soft halo glow.
 * The default visualization: bass drives the centre disk + halo radius,
 * frequency bins radiate outward (mirrored left/right), and a circular
 * oscilloscope traces the waveform around the ring.
 */
export const PulseMode: VisualizerMode = {
  id: "pulse",
  label: "Pulse",

  setup(ctx: CanvasRenderingContext2D, frame: VizFrame): void {
    // Solid clear on activation so a previous mode's trails don't leak in.
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, frame.width, frame.height);
  },

  draw(ctx: CanvasRenderingContext2D, frame: VizFrame): void {
    const { width, height, freqBytes, waveBytes, bass, mid, treble, level, hueShift, time } = frame;

    // Motion-blur clear: thin black overlay creates a soft trail.
    ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
    ctx.fillRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const minDim = Math.min(width, height);
    const baseRadius = minDim * 0.16 + bass * minDim * 0.05;
    const hue = (hueShift + bass * 40) % 360;

    // ---- Outer halo (radial gradient, breathes with bass) ---------------
    const haloRadius = minDim * 0.5;
    const halo = ctx.createRadialGradient(cx, cy, baseRadius * 0.85, cx, cy, haloRadius);
    halo.addColorStop(0, `hsla(${hue}, 95%, 65%, ${0.18 + bass * 0.32})`);
    halo.addColorStop(0.45, `hsla(${(hue + 60) % 360}, 95%, 55%, ${0.06 + mid * 0.15})`);
    halo.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, width, height);

    // ---- Spectrum bars radiating outward, mirrored left/right -----------
    const bins = Math.min(freqBytes.length, 220);
    const half = Math.floor(bins / 2);
    const ringR = baseRadius + minDim * 0.005;
    const maxLen = minDim * 0.32;

    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(1.5, minDim * 0.0035);

    for (let i = 1; i < half; i++) {
      const v = freqBytes[i] / 255;
      if (v < 0.02) continue;
      const len = v * maxLen + 4;
      const t = i / half;
      const barHue = (hue + t * 130) % 360;
      ctx.strokeStyle = `hsla(${barHue}, 95%, ${52 + v * 28}%, ${0.5 + v * 0.5})`;

      // Right side
      const aR = -Math.PI / 2 + t * Math.PI;
      const cosR = Math.cos(aR);
      const sinR = Math.sin(aR);
      ctx.beginPath();
      ctx.moveTo(cx + cosR * ringR, cy + sinR * ringR);
      ctx.lineTo(cx + cosR * (ringR + len), cy + sinR * (ringR + len));
      ctx.stroke();

      // Mirrored left side
      const aL = -Math.PI / 2 - t * Math.PI;
      const cosL = Math.cos(aL);
      const sinL = Math.sin(aL);
      ctx.beginPath();
      ctx.moveTo(cx + cosL * ringR, cy + sinL * ringR);
      ctx.lineTo(cx + cosL * (ringR + len), cy + sinL * (ringR + len));
      ctx.stroke();
    }

    // ---- Circular waveform around the ring ------------------------------
    const wN = waveBytes.length;
    const waveAmp = minDim * (0.045 + treble * 0.02);
    ctx.lineWidth = Math.max(1.4, minDim * 0.0028);
    ctx.strokeStyle = `hsla(${(hue + 200) % 360}, 100%, ${78 + level * 12}%, 0.92)`;
    ctx.beginPath();
    for (let i = 0; i <= wN; i++) {
      const idx = i % wN;
      const v = (waveBytes[idx] - 128) / 128;
      const radius = ringR + v * waveAmp;
      const angle = (i / wN) * Math.PI * 2 - Math.PI / 2 + time * 0.05;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // ---- Centre disk (inner gradient bloom) -----------------------------
    const inner = ctx.createRadialGradient(cx, cy, 0, cx, cy, ringR);
    inner.addColorStop(0, `hsla(${hue}, 100%, 88%, ${0.22 + bass * 0.35})`);
    inner.addColorStop(0.7, `hsla(${(hue + 30) % 360}, 95%, 60%, ${0.05 + bass * 0.15})`);
    inner.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = inner;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.fill();
  },
};
