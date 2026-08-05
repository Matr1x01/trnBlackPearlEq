import { DEVICE_INFO } from "../data/device";
import "./DeviceInfo.css";

interface Props {
  firmware: string | null;
  connected: boolean;
  resetting: boolean;
  onResetEQ: () => void;
}

/**
 * Device identity card. Everything except the firmware version is static
 * (see data/device.ts) -- the HID protocol has no command to read model or
 * manufacturer strings.
 */
export default function DeviceInfo({ firmware, connected, resetting, onResetEQ }: Props) {
  const rows: { icon: string; label: string; value: string }[] = [
    { icon: "▣", label: "Model", value: DEVICE_INFO.model },
    { icon: "◎", label: "Brand", value: DEVICE_INFO.brand },
    { icon: "⌁", label: "Interface", value: DEVICE_INFO.interface },
    { icon: "⚙", label: "Firmware", value: firmware ? `v${firmware}` : "—" },
    { icon: "⬡", label: "USB ID", value: `${DEVICE_INFO.vendorId} : ${DEVICE_INFO.productId}` },
  ];

  return (
    <div className="device-card">
      <div className="device-hero">
        <div className={`device-glyph ${connected ? "online" : ""}`}>
          <span>◈</span>
        </div>
        <div className="device-hero-text">
          <h3 className="device-name">{DEVICE_INFO.name}</h3>
          <p className="device-tagline">{DEVICE_INFO.brand} · TE-C</p>
        </div>
      </div>

      <dl className="device-rows">
        {rows.map((row) => (
          <div className="device-row" key={row.label}>
            <dt>
              <span className="device-row-icon" aria-hidden="true">
                {row.icon}
              </span>
              {row.label}
            </dt>
            <dd className="mono">{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="device-mfr">
        <span className="label-eyebrow">Manufacturer</span>
        <p>{DEVICE_INFO.manufacturer}</p>
      </div>

      <button
        className="btn-outline device-reset"
        onClick={onResetEQ}
        disabled={!connected || resetting}
        title="Flatten all 10 EQ bands and write them to the DAC"
      >
        {resetting ? "Resetting…" : "↺  Reset EQ to flat"}
      </button>
    </div>
  );
}
