import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Preset } from "../api/client";
import { peakBoost } from "../dsp/headroom";
import MiniEQCurve from "./MiniEQCurve";
import "./PresetCard.css";

interface Props {
  preset: Preset;
  active: boolean;
  /** The active preset has unsaved edits on screen. */
  dirty: boolean;
  /** This preset's EQ is what the DAC is currently holding. */
  onDevice: boolean;
  busy: boolean;
  onApply: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onRetarget: (id: string, target: string) => void;
  onDuplicate: (id: string) => void;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
}

/** Gap between the ⋯ button and the menu it opens. */
const MENU_OFFSET = 6;
/** Keep the menu this far clear of the viewport edges. */
const VIEWPORT_MARGIN = 8;

/** Viewport-relative anchor for the menu, measured from the ⋯ button. */
interface MenuAnchor {
  /** Distance from the right edge of the viewport to the button's right edge. */
  right: number;
  /** Where the menu's top goes when it drops down. */
  top: number;
  /** Where the menu's bottom goes when it flips up. */
  bottom: number;
}

export default function PresetCard({
  preset,
  active,
  dirty,
  onDevice,
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
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  // ── Menu placement ──────────────────────────────────────────────────
  // The menu is portalled to <body> and positioned against the button's
  // viewport rect rather than being laid out inside the card. Two reasons,
  // both of which broke it in place:
  //
  //  - Every card animates in with `rise-in`, whose `forwards` fill leaves a
  //    transform on the element. A transform creates a stacking context, so
  //    a card's z-index is sealed inside it and no menu can ever paint over
  //    the cards that follow it in the grid. That is why only the last card
  //    -- the one with nothing painted after it -- looked correct.
  //  - In the docked rail the gallery is an overflow:auto scroller, which
  //    clips a menu hanging past the bottom of a card near the fold.
  //
  // Neither is fixable from inside the card, so the menu leaves it.
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [flipUp, setFlipUp] = useState(false);

  const place = useCallback(() => {
    const btn = menuBtnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setAnchor({
      right: window.innerWidth - r.right,
      top: r.bottom + MENU_OFFSET,
      bottom: window.innerHeight - r.top + MENU_OFFSET,
    });
  }, []);

  // Drop down by default; flip above the button when the menu would not fit
  // below. Measured rather than assumed so adding an action cannot silently
  // push the last item off screen.
  useLayoutEffect(() => {
    if (!menuOpen || !anchor || !menuRef.current) return;
    const height = menuRef.current.offsetHeight;
    setFlipUp(anchor.top + height > window.innerHeight - VIEWPORT_MARGIN);
  }, [menuOpen, anchor]);

  // A fixed-position menu does not travel with the card, so follow it.
  // Capture phase: the dock's scroller scrolls, not the window.
  useEffect(() => {
    if (!menuOpen) return;
    const onScrollOrResize = () => place();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [menuOpen, place]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setAnchor(null);
    setFlipUp(false);
  }, []);

  // Close the overflow menu on an outside click or Escape. The menu itself
  // now lives outside the card in the DOM, so it needs checking separately
  // or clicking an item would tear the menu down before the click landed.
  useEffect(() => {
    if (!menuOpen && !confirmDelete) return;
    const onDocDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
      setConfirmDelete(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeMenu();
        setConfirmDelete(false);
        menuBtnRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, confirmDelete, closeMenu]);

  const enabledCount = preset.bands.filter((b) => b.enabled && b.gainDb !== 0).length;
  // Recommended preamp is just the inverse of the curve's peak boost. It is
  // a property of the preset alone, so the live volume plays no part.
  const preamp = -peakBoost(preset.bands).peakGainDb;

  const startEdit = (field: "name" | "target") => {
    setDraft(field === "name" ? preset.name : preset.target);
    setEditing(field);
    closeMenu();
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
          <span className={`preset-active-tag ${onDevice && !dirty ? "on-device" : ""}`}>
            {dirty ? "Active · edited" : onDevice ? "Active · on DAC" : "Active"}
          </span>
        )}
      </div>

      {/* Sits outside the preview: that box clips its overflow to keep the
          curve inside the rounded corners, which would eat the button. */}
      <div className="preset-menu-wrap">
        <button
          ref={menuBtnRef}
          className="preset-menu-btn"
          aria-label={`Actions for ${preset.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            stop(e);
            setConfirmDelete(false);
            if (menuOpen) {
              closeMenu();
            } else {
              place();
              setMenuOpen(true);
            }
          }}
        >
          ⋯
        </button>
      </div>

      {/* Portalled to <body>: see the placement notes above. Each card keeps
          its own menuOpen state, so this renders that card's actions only. */}
      {menuOpen &&
        anchor &&
        createPortal(
          <div
            className="preset-menu"
            role="menu"
            aria-label={`Actions for ${preset.name}`}
            ref={menuRef}
            style={
              flipUp
                ? { right: anchor.right, bottom: anchor.bottom }
                : { right: anchor.right, top: anchor.top }
            }
            onClick={stop}
          >
            <button role="menuitem" onClick={() => startEdit("name")}>
              <span aria-hidden="true">✎</span> Rename
            </button>
            <button role="menuitem" onClick={() => startEdit("target")}>
              <span aria-hidden="true">◎</span> {preset.target ? "Edit target" : "Set target"}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                closeMenu();
                onDuplicate(preset.id);
              }}
            >
              <span aria-hidden="true">⧉</span> Duplicate
            </button>
            <button
              role="menuitem"
              onClick={() => {
                closeMenu();
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
                closeMenu();
                setConfirmDelete(true);
              }}
            >
              <span aria-hidden="true">✕</span> Delete
            </button>
          </div>,
          document.body,
        )}

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
