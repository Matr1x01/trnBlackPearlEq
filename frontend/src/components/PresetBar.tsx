import { useEffect, useRef, useState } from "react";
import { BAND_COUNT } from "../api/client";
import type { BandType, EQBand, Preset } from "../api/client";
import "./PresetBar.css";

export interface ImportedPreset {
  name: string;
  bands: EQBand[];
}

interface Props {
  presets: Preset[];
  selectedId: string | null;
  /** Current bands differ from the selected preset's stored bands. */
  dirty: boolean;
  busy: boolean;
  connected: boolean;
  onSelect: (id: string | null) => void;
  onSaveAs: (name: string) => void;
  onUpdate: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onFlash: () => void;
  onImport: (items: ImportedPreset[]) => void;
  onExport: () => void;
  onError: (message: string) => void;
}

// Which inline form (if any) is replacing the button row. The Tauri
// webview has no reliable window.prompt/confirm, so naming and delete
// confirmation happen in-place.
type Mode = "idle" | "save" | "rename" | "delete";

export default function PresetBar({
  presets,
  selectedId,
  dirty,
  busy,
  connected,
  onSelect,
  onSaveAs,
  onUpdate,
  onRename,
  onDelete,
  onFlash,
  onImport,
  onExport,
  onError,
}: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [draftName, setDraftName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const selected = presets.find((p) => p.id === selectedId) ?? null;

  useEffect(() => {
    if (mode === "save" || mode === "rename") inputRef.current?.select();
  }, [mode]);

  const openSave = () => {
    setDraftName(selected ? `${selected.name} copy` : "New Preset");
    setMode("save");
  };

  const openRename = () => {
    if (!selected) return;
    setDraftName(selected.name);
    setMode("rename");
  };

  const submitName = () => {
    const name = draftName.trim();
    if (!name) {
      onError("Preset name must not be empty");
      return;
    }
    if (mode === "save") onSaveAs(name);
    else onRename(name);
    setMode("idle");
  };

  const handleFile = async (file: File) => {
    try {
      const items = parsePresetFile(await file.text());
      if (items.length === 0) throw new Error("no presets found in file");
      onImport(items);
    } catch (e: any) {
      onError(`Import failed: ${e.message ?? e}`);
    }
  };

  return (
    <div className="preset-bar">
      <div className="preset-row">
        <span className="label-eyebrow preset-label">Preset</span>

        <select
          className="preset-select"
          value={selectedId ?? ""}
          disabled={busy}
          onChange={(e) => onSelect(e.target.value || null)}
        >
          <option value="">— Device / unsaved —</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        {selected && dirty && (
          <span className="preset-dirty" title="Bands differ from the stored preset">
            ● modified
          </span>
        )}

        {mode === "idle" && (
          <div className="preset-actions">
            <button className="btn-ghost" onClick={openSave} disabled={busy}>
              Save as…
            </button>
            <button
              className="btn-ghost"
              onClick={onUpdate}
              disabled={busy || !selected || !dirty}
              title={selected ? "Overwrite this preset with the current bands" : "Select a preset first"}
            >
              Update
            </button>
            <button className="btn-ghost" onClick={openRename} disabled={busy || !selected}>
              Rename
            </button>
            <button
              className="btn-ghost btn-danger"
              onClick={() => setMode("delete")}
              disabled={busy || !selected}
            >
              Delete
            </button>
            <span className="preset-sep" />
            <button
              className="btn-ghost btn-flash"
              onClick={onFlash}
              disabled={busy || !connected}
              title="Write the current EQ to the DAC's flash so it survives a power cycle"
            >
              ⚡ Flash to DAC
            </button>
            <span className="preset-sep" />
            <button className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
              Import
            </button>
            <button className="btn-ghost" onClick={onExport} disabled={busy || presets.length === 0}>
              Export
            </button>
          </div>
        )}

        {(mode === "save" || mode === "rename") && (
          <div className="preset-actions">
            <input
              ref={inputRef}
              className="preset-name-input"
              value={draftName}
              autoFocus
              maxLength={64}
              placeholder="Preset name"
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitName();
                if (e.key === "Escape") setMode("idle");
              }}
            />
            <button className="btn-ghost btn-confirm" onClick={submitName}>
              {mode === "save" ? "Save" : "Rename"}
            </button>
            <button className="btn-ghost" onClick={() => setMode("idle")}>
              Cancel
            </button>
          </div>
        )}

        {mode === "delete" && selected && (
          <div className="preset-actions">
            <span className="preset-confirm-text">Delete “{selected.name}”?</span>
            <button
              className="btn-ghost btn-danger"
              onClick={() => {
                onDelete();
                setMode("idle");
              }}
            >
              Delete
            </button>
            <button className="btn-ghost" onClick={() => setMode("idle")}>
              Cancel
            </button>
          </div>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // let the same file be picked again
          if (file) handleFile(file);
        }}
      />
    </div>
  );
}

/**
 * Accepts either a whole exported library (`{presets: [...]}`), a bare
 * array of presets, or a single preset object, so a file shared by
 * another user imports without hand-editing.
 */
export function parsePresetFile(text: string): ImportedPreset[] {
  const data = JSON.parse(text);
  const raw: any[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.presets)
    ? data.presets
    : [data];

  return raw.map((item, i) => {
    const name = typeof item?.name === "string" && item.name.trim() ? item.name.trim() : `Imported ${i + 1}`;
    if (!Array.isArray(item?.bands) || item.bands.length !== BAND_COUNT) {
      throw new Error(`"${name}" must contain exactly ${BAND_COUNT} bands`);
    }
    const bands: EQBand[] = item.bands.map((b: any, idx: number) => {
      const freqHz = Number(b?.freqHz);
      const q = Number(b?.q);
      const gainDb = Number(b?.gainDb);
      if (!Number.isFinite(freqHz) || !Number.isFinite(q) || !Number.isFinite(gainDb)) {
        throw new Error(`"${name}" band ${idx + 1} has non-numeric values`);
      }
      const type = String(b?.type ?? "PK").toUpperCase();
      if (type !== "PK" && type !== "LS" && type !== "HS") {
        throw new Error(`"${name}" band ${idx + 1} has unknown type "${b?.type}"`);
      }
      return {
        type: type as BandType,
        freqHz,
        q,
        gainDb,
        enabled: typeof b?.enabled === "boolean" ? b.enabled : gainDb !== 0,
      };
    });
    return { name, bands };
  });
}
