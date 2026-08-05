import { useState } from "react";
import "./LevelSlider.css";

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  formatValue?: (v: number) => string;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  warning?: string;
  disabled?: boolean;
  /**
   * Fill outward from the centre instead of from the left. For controls
   * where zero is the neutral point (balance) rather than the floor.
   */
  bipolar?: boolean;
}

export default function LevelSlider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "",
  formatValue,
  onChange,
  onCommit,
  warning,
  disabled,
  bipolar,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const display = formatValue ? formatValue(value) : `${value}${unit}`;

  // The filled span of the track, as percentages the CSS gradient reads.
  const pct = ((value - min) / (max - min)) * 100;
  const origin = bipolar ? 50 : 0;
  const fillStart = Math.min(origin, pct);
  const fillEnd = Math.max(origin, pct);

  return (
    <div
      className={`level-slider ${disabled ? "disabled" : ""} ${dragging ? "dragging" : ""} ${
        warning ? "warned" : ""
      }`}
    >
      <div className="level-slider-header">
        <span className="label-eyebrow">{label}</span>
        <span className="level-slider-value mono">{display}</span>
      </div>

      <div className="level-slider-rail">
        {bipolar && <span className="level-slider-center" aria-hidden="true" />}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          style={
            {
              "--fill-start": `${fillStart}%`,
              "--fill-end": `${fillEnd}%`,
            } as React.CSSProperties
          }
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerDown={() => setDragging(true)}
          onPointerUp={(e) => {
            setDragging(false);
            onCommit?.(Number((e.target as HTMLInputElement).value));
          }}
          onPointerCancel={() => setDragging(false)}
          onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        />
      </div>

      {warning && <div className="level-slider-warning">{warning}</div>}
    </div>
  );
}
