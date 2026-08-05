import { useEffect, useRef, useState } from "react";
import type { Preset } from "../api/client";
import { analyzeHeadroom } from "../dsp/headroom";
import MiniEQCurve from "./MiniEQCurve";
import "./PresetCard.css";

interface Props {
  preset: Preset;
  active: boolean;
  /** The active preset has unsaved edits on screen. */
  dirty: boolean;
  busy: boolean;
  onApply: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onRetarget: (id: string, target: string) => void;
  onDuplicate: (id: string) => void;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
}

export default function PresetCard({
  preset,
  active,
  dirty,
  busy,
  onApply,
  onRename,
  onRetarget,
  onDuplicate,
  onExport,
  onDelete,
  onTogglePin,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<"name" | "target" | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // In the docked rail the gallery scrolls, so a menu opened on a card
  // near the bottom would hang below the fold. Nudge it into view.
  useEffect(() => {
    if (menuOpen) menuRef.current?.scrollIntoView({ block: "nearest" });
  }, [menuOpen]);

  // Close the overflow menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen && !confirmDelete) return;
    const onDocDown = (e: PointerEvent) => {
      if (!cardRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirmDelete(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setConfirmDelete(false);
      }
    };
    document.addEventListener("pointerdown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, confirmDelete]);

  const enabledCount = preset.bands.filter((b) => b.enabled && b.gainDb !== 0).length;
  const hr = analyzeHeadroom(preset.bands, 50);
  // Recommended preamp is just the inverse of the curve's peak boost.
  const preamp = -hr.peakGainDb;

  const startEdit = (field: "name" | "target") => {
    setDraft(field === "name" ? preset.name : preset.target);
    setEditing(field);
    setMenuOpen(false);
  };

  const commitEdit = () => {
    const value = draft.trim();
    if (editing === "name") {
      if (value && value !== preset.name) onRename(preset.id, value);
    } else if (editing === "target") {
      if (value !== preset.target) onRetarget(preset.id, value);
    }
    setEditing(null);
  };

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      ref={cardRef}
      className={`preset-card ${active ? "active" : ""} ${busy ? "busy" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={`Apply preset ${preset.name}`}
      onClick={() => {
        if (editing || menuOpen || confirmDelete) return;
        onApply(preset.id);
      }}
      onKeyDown={(e) => {
        if (editing || menuOpen) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onApply(preset.id);
        }
      }}
    >
      {/* ── Preview ── */}
      <div className="preset-card-preview">
        <MiniEQCurve bands={preset.bands} muted={!active} />

        <button
          className={`preset-pin ${preset.pinned ? "pinned" : ""}`}
          aria-label={preset.pinned ? "Unpin preset" : "Pin preset"}
          aria-pressed={preset.pinned}
          title={preset.pinned ? "Unpin" : "Pin to top"}
          onClick={(e) => {
            stop(e);
            onTogglePin(preset.id);
          }}
        >
          {preset.pinned ? "★" : "☆"}
        </button>

        {active && (
          <span className="preset-active-tag">{dirty ? "Active · edited" : "Active"}</span>
        )}
      </div>

      {/* Sits outside the preview: that box clips its overflow to keep the
          curve inside the rounded corners, which would eat the menu. */}
      <div className="preset-menu-wrap">
        <button
          className="preset-menu-btn"
          aria-label="Preset actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            stop(e);
            setConfirmDelete(false);
            setMenuOpen((v) => !v);
          }}
        >
          ⋯
        </button>

        {menuOpen && (
          <div className="preset-menu" role="menu" ref={menuRef} onClick={stop}>
            <button role="menuitem" onClick={() => startEdit("name")}>
              <span aria-hidden="true">✎</span> Rename
            </button>
            <button role="menuitem" onClick={() => startEdit("target")}>
              <span aria-hidden="true">◎</span> {preset.target ? "Edit target" : "Set target"}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onDuplicate(preset.id);
              }}
            >
              <span aria-hidden="true">⧉</span> Duplicate
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onExport(preset.id);
              }}
            >
              <span aria-hidden="true">↓</span> Export
            </button>
            <div className="preset-menu-sep" />
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                setMenuOpen(false);
                setConfirmDelete(true);
              }}
            >
              <span aria-hidden="true">✕</span> Delete
            </button>
          </div>
        )}
      </div>

      {/* ── Body ── */}
      <div className="preset-card-body">
        {editing ? (
          <input
            className="preset-card-input"
            autoFocus
            maxLength={64}
            value={draft}
            placeholder={editing === "name" ? "Preset name" : "Headphone or IEM"}
            onClick={stop}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              stop(e);
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") setEditing(null);
            }}
          />
        ) : (
          <>
            <h3 className="preset-card-name" title={preset.name}>
              {preset.name}
            </h3>
            {preset.target && (
              <p className="preset-card-target" title={preset.target}>
                ◎ {preset.target}
              </p>
            )}
          </>
        )}

        <div className="preset-card-meta">
          <span title="Bands with a non-zero gain">
            {enabledCount} band{enabledCount === 1 ? "" : "s"}
          </span>
          <span className="preset-meta-dot" />
          <span
            className={preamp < -0.05 ? "preamp-cut" : undefined}
            title="Recommended preamp: the attenuation needed to keep this curve below 0 dBFS"
          >
            {preamp < -0.05 ? `${preamp.toFixed(1)} dB` : "0 dB"}
          </span>
          <span className="preset-meta-dot" />
          <span title={`Modified ${new Date(preset.updatedAt).toLocaleString()}`}>
            {relativeTime(preset.updatedAt)}
          </span>
        </div>
      </div>

      {/* ── Delete confirmation ── */}
      {confirmDelete && (
        <div className="preset-confirm" onClick={stop}>
          <p>
            Delete <strong>{preset.name}</strong>?
          </p>
          <div className="preset-confirm-actions">
            <button
              className="btn-ghost btn-danger"
              onClick={() => {
                setConfirmDelete(false);
                onDelete(preset.id);
              }}
            >
              Delete
            </button>
            <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Compact "2 days ago" style stamp for the card footer. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}
