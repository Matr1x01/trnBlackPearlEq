import { useMemo, useRef, useState } from "react";
import type { EQBand, Preset } from "../api/client";
import { BAND_COUNT } from "../api/client";
import type { BandType } from "../api/client";
import PresetCard from "./PresetCard";
import "./PresetGallery.css";

export interface ImportedPreset {
  name: string;
  target?: string;
  bands: EQBand[];
}

export type SortKey = "pinned" | "name" | "used" | "created" | "modified";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "pinned", label: "Pinned first" },
  { value: "name", label: "Name (A–Z)" },
  { value: "used", label: "Recently used" },
  { value: "created", label: "Recently created" },
  { value: "modified", label: "Last modified" },
];

interface Props {
  presets: Preset[];
  selectedId: string | null;
  dirty: boolean;
  busy: boolean;
  onApply: (id: string) => void;
  onSaveCurrent: (name: string) => void;
  onUpdateCurrent: () => void;
  onRename: (id: string, name: string) => void;
  onRetarget: (id: string, target: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
  onExportOne: (id: string) => void;
  onExportAll: () => void;
  onImport: (items: ImportedPreset[]) => void;
  onError: (message: string) => void;
}

export default function PresetGallery({
  presets,
  selectedId,
  dirty,
  busy,
  onApply,
  onSaveCurrent,
  onUpdateCurrent,
  onRename,
  onRetarget,
  onDuplicate,
  onDelete,
  onTogglePin,
  onExportOne,
  onExportAll,
  onImport,
  onError,
}: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("pinned");
  const [saving, setSaving] = useState(false);
  const [draftName, setDraftName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? presets.filter(
          (p) => p.name.toLowerCase().includes(q) || p.target.toLowerCase().includes(q)
        )
      : presets.slice();

    const byName = (a: Preset, b: Preset) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    // Never-used presets sort last rather than jumping to the top as epoch 0.
    const byUsed = (a: Preset, b: Preset) =>
      stamp(b.lastUsedAt) - stamp(a.lastUsedAt) || byName(a, b);

    switch (sort) {
      case "name":
        filtered.sort(byName);
        break;
      case "used":
        filtered.sort(byUsed);
        break;
      case "created":
        filtered.sort((a, b) => stamp(b.createdAt) - stamp(a.createdAt));
        break;
      case "modified":
        filtered.sort((a, b) => stamp(b.updatedAt) - stamp(a.updatedAt));
        break;
      case "pinned":
      default:
        // Pinned block on top, each block ordered by most recent use.
        filtered.sort((a, b) => Number(b.pinned) - Number(a.pinned) || byUsed(a, b));
        break;
    }
    return filtered;
  }, [presets, query, sort]);

  const submitSave = () => {
    const name = draftName.trim();
    if (!name) {
      onError("Preset name must not be empty");
      return;
    }
    onSaveCurrent(name);
    setDraftName("");
    setSaving(false);
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
    <section className="panel preset-gallery">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">Preset Library</h2>
          <p className="panel-sub">
            {presets.length === 0
              ? "Save the current EQ to start your library"
              : `${presets.length} preset${presets.length === 1 ? "" : "s"} · tap a card to apply it`}
          </p>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="preset-toolbar">
        <div className="preset-search">
          <span className="preset-search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            type="search"
            placeholder="Search presets…"
            value={query}
            aria-label="Search presets"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="preset-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
              ×
            </button>
          )}
        </div>

        <label className="preset-sort">
          <span className="label-eyebrow">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <div className="preset-toolbar-actions">
          {selectedId && dirty && (
            <button className="btn-ghost btn-confirm" onClick={onUpdateCurrent} disabled={busy}>
              Update active
            </button>
          )}
          {saving ? (
            <div className="preset-save-inline">
              <input
                autoFocus
                maxLength={64}
                placeholder="Preset name"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitSave();
                  if (e.key === "Escape") setSaving(false);
                }}
              />
              <button className="btn-ghost btn-confirm" onClick={submitSave}>
                Save
              </button>
              <button className="btn-ghost" onClick={() => setSaving(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <>
              <button
                className="btn-ghost btn-confirm"
                onClick={() => {
                  setDraftName("");
                  setSaving(true);
                }}
                disabled={busy}
              >
                + Save current
              </button>
              <button className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
                Import
              </button>
              <button className="btn-ghost" onClick={onExportAll} disabled={busy || presets.length === 0}>
                Export all
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Grid ── */}
      {visible.length > 0 ? (
        <div className="preset-grid">
          {visible.map((p) => (
            <PresetCard
              key={p.id}
              preset={p}
              active={p.id === selectedId}
              dirty={dirty}
              busy={busy}
              onApply={onApply}
              onRename={onRename}
              onRetarget={onRetarget}
              onDuplicate={onDuplicate}
              onExport={onExportOne}
              onDelete={onDelete}
              onTogglePin={onTogglePin}
            />
          ))}
        </div>
      ) : (
        <div className="preset-empty">
          {presets.length === 0 ? (
            <>
              <p className="preset-empty-title">No presets yet</p>
              <p>
                Dial in the EQ above, then hit <strong>Save current</strong> to keep it. Saved
                presets can be applied with a single tap and flashed to the DAC.
              </p>
            </>
          ) : (
            <>
              <p className="preset-empty-title">Nothing matches “{query}”</p>
              <p>Try a different name, or clear the search.</p>
            </>
          )}
        </div>
      )}

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
    </section>
  );
}

function stamp(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
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
    const name =
      typeof item?.name === "string" && item.name.trim() ? item.name.trim() : `Imported ${i + 1}`;
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
    return {
      name,
      target: typeof item?.target === "string" ? item.target : "",
      bands,
    };
  });
}
