import { useId, useMemo, useRef, useState } from "react";
import type { EQBand } from "../api/client";
import { combinedResponseDb } from "../dsp/biquad";
import { ceilingDbAt } from "../dsp/headroom";
import "./EQGraph.css";

const WIDTH = 860;
const HEIGHT = 330;
const PAD_L = 40;
const PAD_R = 22;
const PAD_T = 26;
const PAD_B = 32;
const MAX_DB = 15;
const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const FREQ_LABELS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const DB_LINES = [-12, -6, 0, 6, 12];

const PLOT_W = WIDTH - PAD_L - PAD_R;
const PLOT_H = HEIGHT - PAD_T - PAD_B;

function xToFreq(x: number) {
  const t = (x - PAD_L) / PLOT_W;
  return FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t);
}
function freqToX(f: number) {
  return PAD_L + PLOT_W * (Math.log10(f / FREQ_MIN) / Math.log10(FREQ_MAX / FREQ_MIN));
}
function dbToY(db: number) {
  return PAD_T + PLOT_H / 2 - (db / MAX_DB) * (PLOT_H / 2);
}
function yToDb(y: number) {
  return ((PAD_T + PLOT_H / 2 - y) / (PLOT_H / 2)) * MAX_DB;
}

interface Props {
  bands: EQBand[];
  activeIndex: number;
  /**
   * Master volume, 0-100. Used only to place the output ceiling; the curve
   * itself stays pure EQ gain.
   */
  volumePercent: number;
  onSelect: (idx: number) => void;
  /** Called continuously while dragging (freq/gain preview). */
  onDrag: (idx: number, freqHz: number, gainDb: number) => void;
  /** Called once when a drag ends -- the point to actually write to hardware. */
  onCommit: (idx: number, freqHz: number, gainDb: number) => void;
  disabled?: boolean;
}

export default function EQGraph({
  bands,
  activeIndex,
  volumePercent,
  onSelect,
  onDrag,
  onCommit,
  disabled,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Scoped so a second graph on the page cannot capture this one's clip.
  // useId embeds colons, which are legal in an id but awkward inside url(#…),
  // so they are stripped.
  const clipId = `eq-over-ceiling-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  // 2px sampling keeps the crest of a high-Q band from looking faceted.
  const { curvePath, fillPath, peakDb } = useMemo(() => {
    const step = 2;
    let d = "";
    let peak = 0;
    for (let x = PAD_L; x <= PAD_L + PLOT_W; x += step) {
      const db = combinedResponseDb(bands, xToFreq(x));
      if (db > peak) peak = db;
      d += (x === PAD_L ? "M" : "L") + x.toFixed(1) + " " + dbToY(db).toFixed(1) + " ";
    }
    const zeroY = dbToY(0);
    return {
      curvePath: d.trim(),
      fillPath: `${d} L${(PAD_L + PLOT_W).toFixed(1)} ${zeroY} L${PAD_L} ${zeroY} Z`,
      // Taken from the sampled curve rather than an independent sweep, so the
      // "is it over?" verdict always agrees with what is actually drawn.
      peakDb: peak,
    };
  }, [bands]);

  // ── Output ceiling ────────────────────────────────────────────────────
  // Master volume and EQ boost are drawn from the same maximum gain the
  // output stage can represent (docs/pyblackpearl-findings.md §1), so the
  // boost still available is VOL_MAX_DB - volumeDb. Because that lives in
  // the same dB units as the curve, it plots as a line on this very axis:
  // wherever the curve rises above it, EQ + volume overshoots the device's
  // maximum. Volume is deliberately not added to the curve -- that would
  // stop it being the filter response.
  const ceilingDb = ceilingDbAt(volumePercent);
  // Above MAX_DB there is more headroom than the graph shows; the line is
  // off-scale and there is nothing to warn about, so it stays hidden.
  const ceilingVisible = ceilingDb < MAX_DB;
  const ceilingY = dbToY(Math.min(ceilingDb, MAX_DB));
  const overCeiling = ceilingVisible && peakDb > ceilingDb;

  const toSvgPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * WIDTH,
      y: ((clientY - rect.top) / rect.height) * HEIGHT,
    };
  };

  const handlePointerDown = (idx: number) => (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDraggingIdx(idx);
    onSelect(idx);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (draggingIdx === null) return;
    const { x, y } = toSvgPoint(e.clientX, e.clientY);
    const freq = clamp(xToFreq(clamp(x, PAD_L, PAD_L + PLOT_W)), FREQ_MIN, FREQ_MAX);
    const gain = clamp(yToDb(clamp(y, PAD_T, PAD_T + PLOT_H)), -MAX_DB, MAX_DB);
    onDrag(draggingIdx, Math.round(freq), Math.round(gain * 10) / 10);
  };

  const handlePointerUp = () => {
    if (draggingIdx === null) return;
    const b = bands[draggingIdx];
    onCommit(draggingIdx, b.freqHz, b.gainDb);
    setDraggingIdx(null);
  };

  const readoutIdx = hoverIdx ?? activeIndex;
  const readout = bands[readoutIdx];

  return (
    <div className={`eq-graph-wrap ${disabled ? "disabled" : ""}`}>
      <svg
        ref={svgRef}
        className="eq-graph"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <defs>
          <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.20" />
            <stop offset="60%" stopColor="var(--accent)" stopOpacity="0.04" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>

          {/* Everything above the ceiling. Redrawing the curve through this
              recolours only the segments that actually overshoot, which
              points at the bands responsible instead of just saying "some
              part of this clips". */}
          <clipPath id={clipId}>
            <rect x={PAD_L} y={PAD_T} width={PLOT_W} height={Math.max(0, ceilingY - PAD_T)} />
          </clipPath>
        </defs>

        {/* dB grid */}
        {DB_LINES.map((db) => (
          <g key={db}>
            <line
              x1={PAD_L}
              x2={PAD_L + PLOT_W}
              y1={dbToY(db)}
              y2={dbToY(db)}
              className={db === 0 ? "grid-line-zero" : "grid-line"}
            />
            <text x={PAD_L - 8} y={dbToY(db) + 3} className="grid-label mono" textAnchor="end">
              {db > 0 ? `+${db}` : db}
            </text>
          </g>
        ))}

        {/* frequency grid */}
        {FREQ_LABELS.map((f) => (
          <g key={f}>
            <line
              x1={freqToX(f)}
              x2={freqToX(f)}
              y1={PAD_T}
              y2={PAD_T + PLOT_H}
              className="grid-line"
            />
            <text
              x={freqToX(f)}
              y={HEIGHT - 8}
              className="grid-label mono"
              textAnchor="middle"
            >
              {f >= 1000 ? `${f / 1000}k` : f}
            </text>
          </g>
        ))}

        {/* guide line under the focused band */}
        {readout && (
          <line
            x1={freqToX(readout.freqHz)}
            x2={freqToX(readout.freqHz)}
            y1={PAD_T}
            y2={PAD_T + PLOT_H}
            className="eq-guide"
          />
        )}

        {/* ── Output ceiling: how much boost is left at this volume ── */}
        {ceilingVisible && (
          <g className={`eq-ceiling ${overCeiling ? "exceeded" : ""}`}>
            <title>
              {overCeiling
                ? `The curve peaks at +${peakDb.toFixed(1)} dB but only +${ceilingDb.toFixed(1)} dB ` +
                  `of boost fits at ${Math.round(volumePercent)}% volume. Lower the volume or cut the ` +
                  `offending bands.`
                : `At ${Math.round(volumePercent)}% volume the DAC can still take +${ceilingDb.toFixed(1)} dB ` +
                  `of EQ boost before its output stage runs out of range.`}
            </title>
            <rect
              x={PAD_L}
              y={PAD_T}
              width={PLOT_W}
              height={Math.max(0, ceilingY - PAD_T)}
              className="eq-ceiling-zone"
            />
            <line x1={PAD_L} x2={PAD_L + PLOT_W} y1={ceilingY} y2={ceilingY} className="eq-ceiling-line" />
            <text x={PAD_L + 7} y={ceilingY - 6} className="eq-ceiling-label mono">
              {`DAC ceiling · +${ceilingDb.toFixed(1)} dB left at ${Math.round(volumePercent)}% volume`}
            </text>
          </g>
        )}

        <path d={fillPath} fill="url(#eqFill)" className="response-fill" />
        <path d={curvePath} className="response-curve" />
        {overCeiling && (
          <path d={curvePath} className="response-curve over-ceiling" clipPath={`url(#${clipId})`} />
        )}

        {/* band nodes */}
        {bands.map((b, idx) => {
          const cx = freqToX(b.freqHz);
          const cy = dbToY(b.gainDb);
          const active = idx === activeIndex;
          const hot = idx === hoverIdx || idx === draggingIdx;
          return (
            <g
              key={idx}
              className={`band-node ${active ? "active" : ""} ${hot ? "hot" : ""} ${
                !b.enabled ? "disabled" : ""
              }`}
            >
              {/* Generous invisible target: comfortable for touch without
                  making the visible dot heavy. */}
              <circle
                cx={cx}
                cy={cy}
                r={20}
                className="band-node-hit"
                onPointerDown={handlePointerDown(idx)}
                onPointerEnter={() => setHoverIdx(idx)}
                onPointerLeave={() => setHoverIdx(null)}
                style={{ cursor: disabled ? "default" : draggingIdx === idx ? "grabbing" : "grab" }}
              />
              <circle cx={cx} cy={cy} r={4.5} className="band-node-dot" pointerEvents="none" />
              <text x={cx} y={cy - 13} className="band-node-label mono" textAnchor="middle">
                {idx + 1}
              </text>
            </g>
          );
        })}
      </svg>

      {/* live readout for the focused band */}
      {readout && (
        <div className={`eq-readout ${hoverIdx !== null ? "hovering" : ""}`}>
          <span className="eq-readout-idx mono">{String(readoutIdx + 1).padStart(2, "0")}</span>
          <span className="eq-readout-type">{readout.type}</span>
          <span className="eq-readout-sep" />
          <span className="mono">
            {readout.freqHz >= 1000
              ? `${(readout.freqHz / 1000).toFixed(readout.freqHz >= 10000 ? 1 : 2)} kHz`
              : `${Math.round(readout.freqHz)} Hz`}
          </span>
          <span className="eq-readout-sep" />
          <span className={`mono ${readout.gainDb > 0 ? "pos" : readout.gainDb < 0 ? "neg" : ""}`}>
            {readout.gainDb > 0 ? "+" : ""}
            {readout.gainDb.toFixed(1)} dB
          </span>
          <span className="eq-readout-sep" />
          <span className="mono">Q {readout.q.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
