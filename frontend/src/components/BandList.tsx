import type { BandType, EQBand } from "../api/client";
import "./BandList.css";

interface Props {
  bands: EQBand[];
  activeIndex: number;
  onSelect: (idx: number) => void;
  onChange: (idx: number, band: EQBand) => void;
  onCommit: (idx: number, band: EQBand) => void;
  disabled?: boolean;
}

const TYPES: BandType[] = ["PK", "LS", "HS"];

export default function BandList({ bands, activeIndex, onSelect, onChange, onCommit, disabled }: Props) {
  return (
    <div className={`band-list ${disabled ? "disabled" : ""}`}>
      <div className="band-list-header">
        <span>#</span>
        <span></span>
        <span>Type</span>
        <span>Freq</span>
        <span>Gain</span>
        <span className="band-col-gain-num">dB</span>
        <span>Q</span>
      </div>
      {bands.map((b, idx) => (
        <div
          key={idx}
          className={`band-row ${idx === activeIndex ? "active" : ""}`}
          onClick={() => onSelect(idx)}
        >
          <span className="band-row-index mono">{idx + 1}</span>

          <input
            type="checkbox"
            className="band-enable"
            checked={b.enabled}
            disabled={disabled}
            aria-label={`Enable band ${idx + 1}`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onCommit(idx, { ...b, enabled: e.target.checked })}
          />

          <select
            className="band-type"
            value={b.type}
            disabled={disabled}
            aria-label={`Band ${idx + 1} filter type`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onCommit(idx, { ...b, type: e.target.value as BandType })}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <label className="band-field band-freq">
            <input
              type="number"
              className="mono"
              value={Math.round(b.freqHz)}
              disabled={disabled}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onChange(idx, { ...b, freqHz: Number(e.target.value) })}
              onBlur={() => onCommit(idx, b)}
            />
            <span>Hz</span>
          </label>

          {/* Bipolar fill: the bar grows out from 0 dB in the centre. */}
          <input
            className="band-slider"
            type="range"
            aria-label={`Band ${idx + 1} gain`}
            min={-15}
            max={15}
            step={0.1}
            value={b.gainDb}
            disabled={disabled}
            style={
              {
                "--fill-start": `${Math.min(50, ((b.gainDb + 15) / 30) * 100)}%`,
                "--fill-end": `${Math.max(50, ((b.gainDb + 15) / 30) * 100)}%`,
              } as React.CSSProperties
            }
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onChange(idx, { ...b, gainDb: Number(e.target.value) })}
            onPointerUp={() => onCommit(idx, b)}
          />

          <label className="band-field band-gain">
            <input
              type="number"
              className="mono"
              value={b.gainDb.toFixed(1)}
              disabled={disabled}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onChange(idx, { ...b, gainDb: Number(e.target.value) })}
              onBlur={() => onCommit(idx, b)}
            />
            <span>dB</span>
          </label>

          <label className="band-field band-q">
            <span>Q</span>
            <input
              type="number"
              step={0.05}
              className="mono"
              value={b.q.toFixed(2)}
              disabled={disabled}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onChange(idx, { ...b, q: Number(e.target.value) })}
              onBlur={() => onCommit(idx, b)}
            />
          </label>
        </div>
      ))}
    </div>
  );
}
