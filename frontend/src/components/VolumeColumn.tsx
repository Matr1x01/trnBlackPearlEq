import { useCallback, useRef } from "react";
import type { EQBand } from "../api/client";
import { analyzeHeadroom, formatHz } from "../dsp/headroom";
import { useMediaQuery } from "../hooks/useMediaQuery";
import LevelSlider from "./LevelSlider";
import "./VolumeColumn.css";

/** Boost, in dB, that fills the headroom meter end to end. */
const METER_SPAN_DB = 12;

interface Props {
  volume: number;
  bands: EQBand[];
  disabled?: boolean;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}

export default function VolumeColumn({ volume, bands, disabled, onChange, onCommit }: Props) {
  // Below this width a vertical slider leaves the graph too narrow, so the
  // whole column reflows horizontally under it.
  const stacked = useMediaQuery("(max-width: 720px)");
  const hr = analyzeHeadroom(bands, volume);

  const used = Math.min(Math.max(hr.peakGainDb, 0), METER_SPAN_DB);
  const usedPct = (used / METER_SPAN_DB) * 100;

  const note =
    hr.peakGainDb <= 0.05
      ? "No EQ boost"
      : `Peak +${hr.peakGainDb.toFixed(1)} dB @ ${formatHz(hr.peakFreqHz)}`;

  const readout = (
    <div
      className={`vol-headroom status-${hr.status}`}
      title={
        hr.peakGainDb > 0.05
          ? `A full-scale signal at ${formatHz(hr.peakFreqHz)} would exceed 0 dBFS by ` +
            `${hr.peakGainDb.toFixed(1)} dB. Cut that much to stay clean.`
          : "The EQ applies no boost, so nothing can overshoot 0 dBFS."
      }
    >
      <div className="vol-headroom-top">
        <span className="label-eyebrow">Headroom</span>
        <span className="vol-headroom-icon" aria-hidden="true">
          {hr.status === "safe" ? "✓" : "▲"}
        </span>
      </div>
      <div className="vol-headroom-value mono">
        {hr.headroomDb < 0 ? "−" : ""}
        {Math.abs(hr.headroomDb).toFixed(1)} dB
      </div>
      <div className="vol-headroom-note">{note}</div>
      {hr.masterBoosting && hr.peakGainDb > 0.05 && (
        <div className="vol-headroom-note vol-headroom-master">
          +{hr.volumeDb.toFixed(1)} dB master on top
        </div>
      )}
    </div>
  );

  if (stacked) {
    return (
      <div className="volume-column stacked">
        <LevelSlider
          label="Volume"
          value={volume}
          min={0}
          max={100}
          unit="%"
          onChange={onChange}
          onCommit={onCommit}
          disabled={disabled}
        />
        <div className="vol-meter-h" role="img" aria-label={`Headroom ${hr.headroomDb.toFixed(1)} decibels`}>
          <div className={`vol-meter-h-track status-${hr.status}`}>
            <div className="vol-meter-h-fill" style={{ width: `${usedPct}%` }} />
            <span className="vol-meter-h-zero" style={{ left: "100%" }} />
          </div>
        </div>
        {readout}
      </div>
    );
  }

  return (
    <div className="volume-column">
      <div className="vol-head">
        <span className="label-eyebrow">Volume</span>
        <span className="vol-value mono">{volume}%</span>
      </div>

      <div className="vol-body">
        <VerticalSlider
          value={volume}
          min={0}
          max={100}
          disabled={disabled}
          label="Volume"
          onChange={onChange}
          onCommit={onCommit}
        />

        <div
          className={`vol-meter status-${hr.status}`}
          role="img"
          aria-label={`Headroom ${hr.headroomDb.toFixed(1)} decibels`}
        >
          <div className="vol-meter-track">
            <div className="vol-meter-fill" style={{ height: `${usedPct}%` }} />
            {/* 0 dBFS sits at the top of the meter */}
            <span className="vol-meter-zero" />
          </div>
        </div>
      </div>

      <div className="vol-legend">
        <span>VOL</span>
        <span>PEAK</span>
      </div>

      {readout}
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface VProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  disabled?: boolean;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}

/**
 * Pointer-driven vertical slider.
 *
 * Built by hand rather than rotating an <input type="range">: vertical
 * range inputs still differ across engines (`appearance: slider-vertical`
 * vs `writing-mode`), and a rotated input needs a fixed pixel height,
 * which would stop the column matching the graph's fluid height.
 */
function VerticalSlider({
  value,
  min,
  max,
  step = 1,
  label,
  disabled,
  onChange,
  onCommit,
}: VProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const valueFromY = useCallback(
    (clientY: number) => {
      const el = trackRef.current;
      if (!el) return value;
      const rect = el.getBoundingClientRect();
      // Bottom of the track is `min`, top is `max`.
      const t = 1 - (clientY - rect.top) / rect.height;
      const raw = min + Math.min(Math.max(t, 0), 1) * (max - min);
      return Math.min(Math.max(Math.round(raw / step) * step, min), max);
    },
    [min, max, step, value]
  );

  const handleDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    draggingRef.current = true;
    onChange(valueFromY(e.clientY));
  };

  const handleMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    onChange(valueFromY(e.clientY));
  };

  const handleUp = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    onCommit(valueFromY(e.clientY));
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const big = (max - min) / 10;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowUp":
      case "ArrowRight":
        next = value + step;
        break;
      case "ArrowDown":
      case "ArrowLeft":
        next = value - step;
        break;
      case "PageUp":
        next = value + big;
        break;
      case "PageDown":
        next = value - big;
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = max;
        break;
      default:
        return;
    }
    e.preventDefault();
    const clamped = Math.min(Math.max(next, min), max);
    onChange(clamped);
    onCommit(clamped);
  };

  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div
      ref={trackRef}
      className={`vslider ${disabled ? "disabled" : ""}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value}%`}
      aria-disabled={disabled}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onKeyDown={handleKey}
    >
      <div className="vslider-track">
        <div className="vslider-fill" style={{ height: `${pct}%` }} />
        <div className="vslider-thumb" style={{ bottom: `${pct}%` }} />
      </div>
    </div>
  );
}
