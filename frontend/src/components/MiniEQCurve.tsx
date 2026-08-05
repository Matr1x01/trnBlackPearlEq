import { memo, useMemo } from "react";
import type { EQBand } from "../api/client";
import { combinedResponseDb } from "../dsp/biquad";
import "./MiniEQCurve.css";

/**
 * Read-only thumbnail of an EQ curve — the visual fingerprint on a preset
 * card. Deliberately not the interactive <EQGraph>: no nodes, no pointer
 * handlers, no axis labels, no per-instance state, so a gallery can render
 * dozens of these cheaply.
 *
 * Kept light in three ways:
 *   - memo() on the component, so a card only recomputes when its own
 *     bands array is replaced (store objects are immutable, so identity
 *     is a valid signal here);
 *   - useMemo() on the path string itself;
 *   - a coarse sample count — at ~100px tall, 64 points is already
 *     smoother than the pixel grid can show.
 */

const W = 240;
const H = 96;
const PAD_Y = 8;
const SAMPLES = 64;

const FREQ_MIN = 20;
const FREQ_MAX = 20000;

/**
 * Fixed dB range for every preview. This is the whole point of the
 * thumbnail: curves are only comparable at a glance if they all share one
 * scale, so a gentle tilt never looks like a drastic V.
 */
const SCALE_DB = 15;

const LOG_SPAN = Math.log10(FREQ_MAX / FREQ_MIN);

function xAt(i: number): number {
  return (i / SAMPLES) * W;
}

function freqAt(i: number): number {
  return FREQ_MIN * Math.pow(10, (i / SAMPLES) * LOG_SPAN);
}

function yAt(db: number): number {
  const mid = H / 2;
  const clamped = Math.max(-SCALE_DB, Math.min(SCALE_DB, db));
  return mid - (clamped / SCALE_DB) * (mid - PAD_Y);
}

interface Props {
  bands: EQBand[];
  /** Dims the curve for cards that aren't the active preset. */
  muted?: boolean;
}

function MiniEQCurve({ bands, muted }: Props) {
  const { line, area } = useMemo(() => {
    let d = "";
    for (let i = 0; i <= SAMPLES; i++) {
      const y = yAt(combinedResponseDb(bands, freqAt(i)));
      d += (i === 0 ? "M" : "L") + xAt(i).toFixed(1) + " " + y.toFixed(1) + " ";
    }
    const mid = (H / 2).toFixed(1);
    return { line: d.trim(), area: `${d} L${W} ${mid} L0 ${mid} Z` };
  }, [bands]);

  return (
    <svg
      className={`mini-eq ${muted ? "muted" : ""}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="EQ curve preview"
    >
      {/* Unity reference so a flat preset still reads as "flat", not empty */}
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} className="mini-eq-zero" />
      <path d={area} className="mini-eq-area" />
      <path d={line} className="mini-eq-line" />
    </svg>
  );
}

export default memo(MiniEQCurve);
