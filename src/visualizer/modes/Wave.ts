import type { VisualizerMode, VizFrame } from "../types.ts";

/**
 * Wave - layered oscilloscope. Three overlaid traces in different hues
 * (with vertical offsets) create depth. The primary trace has a soft
 * outer glow proportional to overall loudness.
 */
export const WaveMode: VisualizerMode = {
  id: "wave",
  label: "Wave",

  setup(ctx: CanvasRenderingContext2D, frame: VizFrame): void {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, frame.width, frame.height);
  },

  draw(ctx: CanvasRenderingContext2D, frame: VizFrame): void {
    const { width, height, waveBytes, hueShift, level, treble } = frame;

    // Light trail
    ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
    ctx.fillRect(0, 0, width, height);

    const cy = height / 2;
    const amp = height * (0.28 + treble * 0.06);
    const N = waveBytes.length;
    const step = Math.max(1, Math.floor(N / Math.min(N, width * 1.5)));

    const drawLayer = (layer: number): void => {
      const isPrimary = layer === 0;
      const hue = (hueShift + layer * 55) % 360;
      const alpha = isPrimary ? 0.95 : 0.32 - (layer - 1) * 0.08;
      const lineWidth = isPrimary ? 2 + level * 5 : 1.4;
      const yOffset = (layer - 1) * 22;

      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = `hsla(${hue}, 95%, ${62 + level * 18}%, ${alpha})`;
      ctx.shadowBlur = isPrimary ? 16 + level * 24 : 0;
      ctx.shadowColor = `hsla(${hue}, 95%, 60%, 0.7)`;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      ctx.beginPath();
      let first = true;
      for (let i = 0; i < N; i += step) {
        const v = (waveBytes[i] - 128) / 128;
        const x = (i / (N - 1)) * width;
        const y = cy + v * amp + yOffset;
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    };

    // Back-to-front so the primary line sits on top.
    drawLayer(2);
    drawLayer(1);
    drawLayer(0);

    ctx.shadowBlur = 0;
  },
};
