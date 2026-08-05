import LevelSlider from "./LevelSlider";
import "./MicPanel.css";

interface Props {
  micGain: number;
  disabled: boolean;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}

const MIN_DB = 0;
const MAX_DB = 40;

/** Rough working zones for the built-in mic preamp. */
const ZONES = [
  { upTo: 12, name: "Low", hint: "Close-mic and loud sources. Cleanest noise floor." },
  { upTo: 26, name: "Normal", hint: "Typical desktop and headset use. A good default range." },
  { upTo: 32, name: "Hot", hint: "Distant or quiet sources. Watch for background noise." },
  { upTo: 40, name: "Maximum", hint: "Very quiet sources only — clipping and hiss become likely." },
];

function zoneFor(db: number) {
  return ZONES.find((z) => db <= z.upTo) ?? ZONES[ZONES.length - 1];
}

export default function MicPanel({ micGain, disabled, onChange, onCommit }: Props) {
  const zone = zoneFor(micGain);
  const pct = ((micGain - MIN_DB) / (MAX_DB - MIN_DB)) * 100;

  return (
    <div className="mic-panel">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">Microphone Input</h2>
            <p className="panel-sub">Analogue preamp gain for the headset microphone</p>
          </div>
          <span className={`mic-zone-badge zone-${zone.name.toLowerCase()}`}>{zone.name}</span>
        </div>

        <div className="mic-readout">
          <span className="mic-readout-value mono">{micGain}</span>
          <span className="mic-readout-unit">dB</span>
        </div>

        {/* Gradient rail showing where the current gain sits across the range. */}
        <div className="mic-meter" aria-hidden="true">
          <div className="mic-meter-track">
            <div className="mic-meter-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="mic-meter-ticks">
            {[0, 10, 20, 30, 40].map((t) => (
              <span key={t} className="mono">
                {t}
              </span>
            ))}
          </div>
        </div>

        <LevelSlider
          label="Mic Gain"
          value={micGain}
          min={MIN_DB}
          max={MAX_DB}
          unit=" dB"
          onChange={onChange}
          onCommit={onCommit}
          warning={micGain > 30 ? "High gain — clipping risk" : undefined}
          disabled={disabled}
        />

        <p className="mic-hint">{zone.hint}</p>
      </section>

      <section className="panel mic-notes">
        <h2 className="panel-title">About mic gain</h2>
        <ul>
          <li>
            Gain is applied in the analogue domain before conversion, so raising it lifts the
            signal <em>and</em> the preamp's own noise together.
          </li>
          <li>
            Set it as low as you can while still hitting a healthy level in your recording or chat
            app — that gives the best signal-to-noise ratio.
          </li>
          <li>
            Unlike volume and EQ, mic gain applies immediately and needs no latch command.
          </li>
        </ul>
      </section>
    </div>
  );
}
