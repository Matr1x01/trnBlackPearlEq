import { useMemo } from "react";
import type { FilterSpec } from "../data/filters";
import "./FilterCurve.css";

/**
 * Draws the impulse response of a reconstruction filter.
 *
 * Impulse response (rather than magnitude response) is what actually
 * separates these five: linear- and minimum-phase variants of the same
 * roll-off have near-identical magnitude curves and differ only in where
 * the ringing lands relative to the transient.
 *
 * The curves are modelled, not measured -- a windowed sinc for the linear
 * phase pair, a causal damped sinc for the minimum phase pair, and a
 * zero-order hold for NOS. They are characteristic shapes for each filter
 * class, not a capture of this specific silicon.
 */

const T_MIN = -7;
const T_MAX = 9;
const SAMPLES = 480;

function sinc(x: number): number {
  if (Math.abs(x) < 1e-9) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** Blackman window over |t| <= half, 0 outside. Tapers the sinc smoothly. */
function blackman(t: number, half: number): number {
  if (Math.abs(t) > half) return 0;
  const n = (t + half) / (2 * half);
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * n) + 0.08 * Math.cos(4 * Math.PI * n);
}

function impulse(spec: FilterSpec, t: number): number {
  if (spec.phase === "none") {
    // Non-oversampling: the sample is simply held for one period.
    return t >= 0 && t < 1 ? 1 : 0;
  }
  if (spec.phase === "linear") {
    // Symmetric windowed sinc -- ringing sits on both sides of the peak.
    // A sharp roll-off needs a longer kernel, so it rings for more cycles.
    const half = spec.rolloff === "fast" ? 7 : 2.6;
    return sinc(t) * blackman(t, half);
  }
  // Minimum phase: strictly causal, so nothing precedes the transient and
  // the whole tail decays after it. Slow roll-off settles far sooner.
  if (t < 0) return 0;
  const tau = spec.rolloff === "fast" ? 3.4 : 1.15;
  return sinc(t) * Math.exp(-t / tau);
}

interface Props {
  spec: FilterSpec;
  /** Rendered size. "card" is the compact chooser tile, "hero" the big one. */
  variant?: "card" | "hero";
  active?: boolean;
}

export default function FilterCurve({ spec, variant = "card", active = false }: Props) {
  const W = variant === "hero" ? 640 : 260;
  const H = variant === "hero" ? 260 : 104;
  const padX = variant === "hero" ? 28 : 10;
  const padY = variant === "hero" ? 26 : 12;

  const { line, area, baselineY } = useMemo(() => {
    const innerW = W - padX * 2;
    const innerH = H - padY * 2;
    // Headroom above the peak so the crest never touches the frame; the
    // negative lobes only reach about a fifth of the peak.
    const yTop = padY;
    const yBase = padY + innerH * 0.74;
    const scale = yBase - yTop;

    const x = (t: number) => padX + ((t - T_MIN) / (T_MAX - T_MIN)) * innerW;
    const y = (v: number) => yBase - v * scale;

    let d = "";
    for (let i = 0; i <= SAMPLES; i++) {
      const t = T_MIN + ((T_MAX - T_MIN) * i) / SAMPLES;
      const px = x(t);
      const py = y(impulse(spec, t));
      d += (i === 0 ? "M" : "L") + px.toFixed(2) + " " + py.toFixed(2) + " ";
    }
    return {
      line: d.trim(),
      area: `${d} L${x(T_MAX).toFixed(2)} ${yBase.toFixed(2)} L${x(T_MIN).toFixed(2)} ${yBase.toFixed(2)} Z`,
      baselineY: yBase,
    };
  }, [spec, W, H, padX, padY]);

  const gradId = `fc-grad-${spec.value}-${variant}`;

  return (
    <svg
      className={`filter-curve ${variant} ${active ? "active" : ""}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-label={`${spec.title} impulse response`}
      role="img"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>

      <line
        x1={padX}
        x2={W - padX}
        y1={baselineY}
        y2={baselineY}
        className="filter-curve-axis"
      />
      <path d={area} fill={`url(#${gradId})`} className="filter-curve-area" />
      <path d={line} className="filter-curve-line" />
    </svg>
  );
}
