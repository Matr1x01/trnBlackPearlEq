import "./TabNav.css";

export type TabId = "eq" | "mic" | "filter";

export interface TabDef {
  id: TabId;
  label: string;
  icon: string;
}

export const TABS: TabDef[] = [
  { id: "eq", label: "EQ Effect", icon: "▤" },
  { id: "mic", label: "Microphone", icon: "◍" },
  { id: "filter", label: "DAC Filter", icon: "◈" },
];

interface Props {
  active: TabId;
  onChange: (id: TabId) => void;
}

export default function TabNav({ active, onChange }: Props) {
  return (
    <nav className="tab-nav" role="tablist" aria-label="Control sections">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          className={`tab-btn ${active === tab.id ? "active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          <span className="tab-icon" aria-hidden="true">
            {tab.icon}
          </span>
          <span className="tab-label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
