import type { AmpMode, FilterMode, GainMode } from "../api/client";
import { AMP_MODES, FILTERS, GAIN_MODES, filterSpec } from "../data/filters";
import FilterCurve from "./FilterCurve";
import LevelSlider from "./LevelSlider";
import "./FilterPanel.css";

interface Props {
  filterMode: FilterMode | null;
  gainMode: GainMode | null;
  ampMode: AmpMode | null;
  balance: number;
  disabled: boolean;
  onFilterMode: (v: string) => void;
  onGainMode: (v: string) => void;
  onAmpMode: (v: string) => void;
  onBalance: (v: number) => void;
}

const PHASE_LABEL: Record<string, string> = {
  linear: "Linear phase",
  minimum: "Minimum phase",
  none: "No interpolation",
};

const ROLLOFF_LABEL: Record<string, string> = {
  fast: "Fast roll-off",
  slow: "Slow roll-off",
  none: "Unfiltered",
};

export default function FilterPanel({
  filterMode,
  gainMode,
  ampMode,
  balance,
  disabled,
  onFilterMode,
  onGainMode,
  onAmpMode,
  onBalance,
}: Props) {
  const active = filterSpec(filterMode);

  return (
    <div className="filter-panel">
      {/* ── Hero: the selected filter's response ── */}
      <section className="panel filter-hero">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">Digital Filter Response</h2>
            <p className="panel-sub">
              Impulse response of the active reconstruction filter
            </p>
          </div>
          {active && (
            <div className="filter-hero-tags">
              <span className="tag">{ROLLOFF_LABEL[active.rolloff]}</span>
              <span className="tag">{PHASE_LABEL[active.phase]}</span>
            </div>
          )}
        </div>

        {active ? (
          // Keyed on the filter so switching re-runs the draw-in animation
          // instead of snapping the curve to its new shape.
          <div key={active.value} className="filter-hero-body">
            <div className="filter-hero-graph">
              <FilterCurve spec={active} variant="hero" />
              <div className="filter-hero-axis">
                <span className="mono">− time</span>
                <span className="mono">transient</span>
                <span className="mono">+ time</span>
              </div>
            </div>
            <div className="filter-hero-caption">
              <h3>
                {active.title}
                <span className="filter-hero-sub"> · {active.subtitle}</span>
              </h3>
              <p>{active.description}</p>
            </div>
          </div>
        ) : (
          <div className="filter-empty">Connect the DAC to read its filter setting.</div>
        )}
      </section>

      {/* ── Filter chooser ── */}
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">Reconstruction Filter</h2>
            <p className="panel-sub">Five oversampling characteristics — pick one to audition</p>
          </div>
        </div>

        <div className="filter-grid">
          {FILTERS.map((spec) => {
            const isActive = spec.value === filterMode;
            return (
              <button
                key={spec.value}
                className={`filter-card ${isActive ? "active" : ""}`}
                onClick={() => onFilterMode(spec.value)}
                disabled={disabled}
                aria-pressed={isActive}
              >
                <div className="filter-card-head">
                  <span className="filter-card-title">{spec.title}</span>
                  {isActive && <span className="filter-card-badge">Active</span>}
                </div>
                <span className="filter-card-sub">{spec.subtitle}</span>
                <FilterCurve spec={spec} active={isActive} />
                <p className="filter-card-desc">{spec.description}</p>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Analogue stage ── */}
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">Output Stage</h2>
            <p className="panel-sub">Amplifier topology, gain range and channel balance</p>
          </div>
        </div>

        <div className="mode-grid">
          <div className="mode-group">
            <span className="label-eyebrow">DAC working mode</span>
            <div className="mode-options">
              {AMP_MODES.map((m) => (
                <button
                  key={m.value}
                  className={`mode-card ${ampMode === m.value ? "active" : ""}`}
                  onClick={() => onAmpMode(m.value)}
                  disabled={disabled}
                  aria-pressed={ampMode === m.value}
                >
                  <span className="mode-card-label">{m.label}</span>
                  <span className="mode-card-desc">{m.description}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mode-group">
            <span className="label-eyebrow">Output gain mode</span>
            <div className="mode-options">
              {GAIN_MODES.map((m) => (
                <button
                  key={m.value}
                  className={`mode-card ${gainMode === m.value ? "active" : ""}`}
                  onClick={() => onGainMode(m.value)}
                  disabled={disabled}
                  aria-pressed={gainMode === m.value}
                >
                  <span className="mode-card-label">{m.label}</span>
                  <span className="mode-card-desc">{m.description}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="balance-block">
          <div className="balance-scale">
            <span className="mono">L</span>
            <LevelSlider
              label="Sound channel balance"
              value={balance}
              min={-15}
              max={15}
              formatValue={(v) =>
                v === 0 ? "Center" : v < 0 ? `${Math.abs(v)} ◂ Left` : `Right ▸ ${v}`
              }
              onChange={onBalance}
              onCommit={onBalance}
              disabled={disabled}
              bipolar
            />
            <span className="mono">R</span>
          </div>
        </div>
      </section>
    </div>
  );
}
