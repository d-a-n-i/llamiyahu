import type { VisualizerMode, VizFrame } from "../types.ts";

/**
 * Kaleido - mirrored radial wedges driven by the spectrum, with a
 * circular waveform ring and a bright bass-reactive core.
 */

const WEDGES = 8;

export const KaleidoMode: VisualizerMode = {
  id: "kaleido",
  label: "Kaleido",

  setup(ctx: CanvasRenderingContext2D, frame: VizFrame): void {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, frame.width, frame.height);
  },

  draw(ctx: CanvasRenderingContext2D, frame: VizFrame): void {
    const {
      width,
      height,
      freqBytes,
      waveBytes,
      bass,
      mid,
      treble,
      level,
      hueShift,
      time,
    } = frame;

    ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
    ctx.fillRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const minDim = Math.min(width, height);
    const inner = minDim * (0.12 + bass * 0.06);
    const outer = minDim * (0.22 + mid * 0.12);
    const spin = time * (0.18 + bass * 0.35);
    const slice = (Math.PI * 2) / WEDGES;

    const wash = ctx.createRadialGradient(cx, cy, inner * 0.5, cx, cy, minDim * 0.7);
    wash.addColorStop(0, `hsla(${hueShift}, 90%, 55%, ${0.05 + bass * 0.12})`);
    wash.addColorStop(
      0.55,
      `hsla(${(hueShift + 80) % 360}, 85%, 45%, ${0.03 + mid * 0.06})`,
    );
    wash.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, width, height);

    const bins = Math.min(96, Math.floor(freqBytes.length * 0.45));
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(spin);

    for (let w = 0; w < WEDGES; w++) {
      ctx.save();
      ctx.rotate(w * slice);
      if (w % 2 === 1) ctx.scale(1, -1);

      ctx.beginPath();
      ctx.moveTo(0, 0);
      for (let i = 0; i < bins; i++) {
        const t = i / (bins - 1);
        const energy = freqBytes[i] / 255;
        const ang = slice * 0.92 * t;
        const r = inner + energy * outer * (0.55 + Math.sin(t * Math.PI) * 0.45);
        ctx.lineTo(Math.cos(ang) * r, Math.sin(ang) * r);
      }
      ctx.closePath();

      const hue = (hueShift + (360 / WEDGES) * w + level * 40) % 360;
      const grad = ctx.createLinearGradient(0, 0, outer, outer * 0.3);
      grad.addColorStop(0, `hsla(${hue}, 100%, 70%, ${0.35 + bass * 0.35})`);
      grad.addColorStop(
        0.6,
        `hsla(${(hue + 50) % 360}, 95%, 55%, ${0.2 + mid * 0.25})`,
      );
      grad.addColorStop(1, `hsla(${(hue + 110) % 360}, 90%, 45%, 0.05)`);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = `hsla(${hue}, 100%, 80%, ${0.25 + treble * 0.4})`;
      ctx.lineWidth = 1.2 + level * 1.5;
      ctx.stroke();
      ctx.restore();
    }

    const ringR = inner + outer * 0.85;
    const waveAmp = minDim * (0.04 + treble * 0.035);
    const waveLen = waveBytes.length;
    const step = Math.max(1, Math.floor(waveLen / 360));
    ctx.beginPath();
    let first = true;
    for (let i = 0; i < waveLen; i += step) {
      const sample = (waveBytes[i] - 128) / 128;
      const ang = (i / waveLen) * Math.PI * 2;
      const r = ringR + sample * waveAmp;
      const x = Math.cos(ang) * r;
      const y = Math.sin(ang) * r;
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    ctx.strokeStyle = `hsla(${(hueShift + 200) % 360}, 100%, 78%, ${0.55 + level * 0.35})`;
    ctx.lineWidth = 1.6 + bass * 2;
    ctx.shadowBlur = 18 + level * 30;
    ctx.shadowColor = `hsla(${(hueShift + 200) % 360}, 100%, 60%, 0.65)`;
    ctx.stroke();
    ctx.shadowBlur = 0;

    const coreR = inner * (0.35 + bass * 0.4);
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
    core.addColorStop(0, `hsla(${hueShift}, 100%, 92%, ${0.5 + bass * 0.4})`);
    core.addColorStop(0.5, `hsla(${(hueShift + 30) % 360}, 95%, 60%, 0.25)`);
    core.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, coreR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },
};
