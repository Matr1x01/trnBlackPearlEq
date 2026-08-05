import { useCallback, useEffect, useMemo, useState } from "react";
import { api, subscribeEvents } from "./api/client";
import type { EQBand, FilterMode, GainMode, AmpMode, Preset } from "./api/client";
import EQGraph from "./components/EQGraph";
import BandList from "./components/BandList";
import LevelSlider from "./components/LevelSlider";
import PresetBar from "./components/PresetBar";
import type { ImportedPreset } from "./components/PresetBar";
import TabNav from "./components/TabNav";
import type { TabId } from "./components/TabNav";
import DeviceInfo from "./components/DeviceInfo";
import FilterPanel from "./components/FilterPanel";
import MicPanel from "./components/MicPanel";
import VolumeColumn from "./components/VolumeColumn";
import "./App.css";

// Default flat 10-band EQ
function defaultBands(): EQBand[] {
  const freqs = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  return freqs.map((f) => ({ type: "PK", freqHz: f, q: 0.71, gainDb: 0, enabled: false }));
}

// Bands round-trip through float math on both sides, so compare with a
// tolerance rather than exact equality when deciding "is this preset
// still what's on screen?".
function bandsEqual(a: EQBand[], b: EQBand[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.type === y.type &&
      x.enabled === y.enabled &&
      Math.abs(x.freqHz - y.freqHz) < 0.5 &&
      Math.abs(x.q - y.q) < 0.005 &&
      Math.abs(x.gainDb - y.gainDb) < 0.05
    );
  });
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [firmware, setFirmware] = useState<string | null>(null);

  const [volume, setVolume] = useState(50);
  const [micGain, setMicGain] = useState(0);
  const [balance, setBalance] = useState(0);

  const [filterMode, setFilterMode] = useState<FilterMode | null>(null);
  const [gainMode, setGainMode] = useState<GainMode | null>(null);
  const [ampMode, setAmpMode] = useState<AmpMode | null>(null);

  const [bands, setBands] = useState<EQBand[]>(defaultBands());
  const [activeIdx, setActiveIdx] = useState(0);

  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [presetBusy, setPresetBusy] = useState(false);

  const [tab, setTab] = useState<TabId>("eq");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPreset = useMemo(
    () => presets.find((p) => p.id === selectedPresetId) ?? null,
    [presets, selectedPresetId]
  );
  const presetDirty = selectedPreset ? !bandsEqual(bands, selectedPreset.bands) : false;

  // ── Device state load ───────────────────────────────────────────────
  // Pulls every hardware-backed control from the DAC. Only valid to call
  // once /api/status (or /api/reconnect) has confirmed a connection --
  // used both on mount and after a successful manual reconnect.
  const loadDeviceState = useCallback(async () => {
    const [vol, mic, bal, flt, gain, amp] = await Promise.all([
      api.getVolume(),
      api.getMicGain(),
      api.getBalance(),
      api.getRegister("filter"),
      api.getRegister("gain"),
      api.getRegister("amp"),
    ]);
    setVolume(vol.percent);
    setMicGain(mic.db);
    setBalance(bal.value);
    setFilterMode(flt.value as FilterMode);
    setGainMode(gain.value as GainMode);
    setAmpMode(amp.value as AmpMode);

    const bandResults = await Promise.all(Array.from({ length: 10 }, (_, i) => api.getEQBand(i)));
    setBands(bandResults);
  }, []);

  // ── Initial load ────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const status = await api.status();
        setConnected(status.connected);
        setFirmware(status.firmware);
        if (!status.connected) return;
        await loadDeviceState();
      } catch (e: any) {
        setError(e.message ?? "Failed to connect");
      }
    };
    load();
  }, [loadDeviceState]);

  // ── Manual reconnect ────────────────────────────────────────────────
  // The backend also retries the connection on its own every 2s, but
  // this gives the user an explicit, immediate way to check after
  // plugging the DAC back in, and to populate the UI right away once
  // it's back.
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const status = await api.reconnect();
      setConnected(status.connected);
      setFirmware(status.firmware);
      if (status.connected) {
        await loadDeviceState();
      }
    } catch (e: any) {
      setError(e.message ?? "Reconnect failed");
    } finally {
      setRefreshing(false);
    }
  }, [loadDeviceState]);

  // ── Preset library ──────────────────────────────────────────────────
  // Presets live on the host, so they load whether or not a DAC is
  // plugged in.
  useEffect(() => {
    api
      .listPresets()
      .then(setPresets)
      .catch((e: any) => setError(e.message ?? "Failed to load presets"));
  }, []);

  // ── WebSocket push events ───────────────────────────────────────────
  useEffect(() => {
    if (!connected) return;
    const unsub = subscribeEvents((ev) => {
      if (ev.type === "volume") setVolume(ev.percent);
    });
    return unsub;
  }, [connected]);

  // ── Volume ──────────────────────────────────────────────────────────
  const handleVolumeChange = useCallback((v: number) => setVolume(v), []);
  const handleVolumeCommit = useCallback(async (v: number) => {
    try { await api.setVolume(v); } catch { /* optimistic */ }
  }, []);

  // ── Mic Gain ────────────────────────────────────────────────────────
  const handleMicGainCommit = useCallback(async (v: number) => {
    setMicGain(v);
    try { await api.setMicGain(v); } catch { /* optimistic */ }
  }, []);

  // ── Balance ─────────────────────────────────────────────────────────
  const handleBalanceCommit = useCallback(async (v: number) => {
    setBalance(v);
    try { await api.setBalance(v); } catch { /* optimistic */ }
  }, []);

  // ── Registers ───────────────────────────────────────────────────────
  const handleFilterMode = useCallback(async (v: string) => {
    setFilterMode(v as FilterMode);
    try { await api.setRegister("filter", v); } catch { /* optimistic */ }
  }, []);
  const handleGainMode = useCallback(async (v: string) => {
    setGainMode(v as GainMode);
    try { await api.setRegister("gain", v); } catch { /* optimistic */ }
  }, []);
  const handleAmpMode = useCallback(async (v: string) => {
    setAmpMode(v as AmpMode);
    try { await api.setRegister("amp", v); } catch { /* optimistic */ }
  }, []);

  // ── EQ ──────────────────────────────────────────────────────────────
  const handleBandChange = useCallback((idx: number, band: EQBand) => {
    const updated = { ...band, enabled: band.gainDb !== 0 ? true : band.enabled };
    setBands((prev) => prev.map((b, i) => (i === idx ? updated : b)));
  }, []);

  const handleBandCommit = useCallback(async (idx: number, band: EQBand) => {
    const updated = { ...band, enabled: band.gainDb !== 0 ? true : band.enabled };
    setBands((prev) => prev.map((b, i) => (i === idx ? updated : b)));
    try {
      await api.setEQBand(idx, updated);
    } catch { /* optimistic */ }
  }, []);

  const handleGraphDrag = useCallback((idx: number, freqHz: number, gainDb: number) => {
    setBands((prev) =>
      prev.map((b, i) => (i === idx ? { ...b, freqHz, gainDb, enabled: gainDb !== 0 ? true : b.enabled } : b))
    );
  }, []);

  const handleGraphCommit = useCallback(async (idx: number, freqHz: number, gainDb: number) => {
    const enabled = gainDb !== 0 ? true : bands[idx].enabled;
    const band = { ...bands[idx], freqHz, gainDb, enabled };
    setBands((prev) => prev.map((b, i) => (i === idx ? band : b)));
    try { await api.setEQBand(idx, band); } catch { /* optimistic */ }
  }, [bands]);

  // ── Presets ─────────────────────────────────────────────────────────
  // Every preset action funnels through here so the busy flag and the
  // error banner behave the same way for all of them.
  const runPresetAction = useCallback(async (fn: () => Promise<void>) => {
    setPresetBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setError(e.message ?? "Preset action failed");
    } finally {
      setPresetBusy(false);
    }
  }, []);

  // Selecting a preset loads it into the editor and pushes it to the
  // DAC live (latch only). Persisting it is the separate Flash action,
  // so browsing presets never burns a flash cycle.
  const handleSelectPreset = useCallback(
    (id: string | null) => {
      setSelectedPresetId(id);
      if (!id) return;
      const preset = presets.find((p) => p.id === id);
      if (!preset) return;
      setBands(preset.bands.map((b) => ({ ...b })));
      if (!connected) return;
      runPresetAction(async () => {
        await api.applyPreset(id, false);
      });
    },
    [presets, connected, runPresetAction]
  );

  const handleSavePresetAs = useCallback(
    (name: string) => {
      runPresetAction(async () => {
        const created = await api.createPreset(name, bands);
        setPresets((prev) => [...prev, created]);
        setSelectedPresetId(created.id);
      });
    },
    [bands, runPresetAction]
  );

  const handleUpdatePreset = useCallback(() => {
    if (!selectedPresetId) return;
    runPresetAction(async () => {
      const updated = await api.updatePreset(selectedPresetId, { bands });
      setPresets((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    });
  }, [selectedPresetId, bands, runPresetAction]);

  const handleRenamePreset = useCallback(
    (name: string) => {
      if (!selectedPresetId) return;
      runPresetAction(async () => {
        const updated = await api.updatePreset(selectedPresetId, { name });
        setPresets((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      });
    },
    [selectedPresetId, runPresetAction]
  );

  const handleDeletePreset = useCallback(() => {
    if (!selectedPresetId) return;
    const id = selectedPresetId;
    runPresetAction(async () => {
      await api.deletePreset(id);
      setPresets((prev) => prev.filter((p) => p.id !== id));
      setSelectedPresetId((cur) => (cur === id ? null : cur));
    });
  }, [selectedPresetId, runPresetAction]);

  // Re-send the preset before flashing so what gets burned is exactly
  // the stored preset. With unsaved edits on screen we flash whatever
  // is already live on the device instead.
  const handleFlashPreset = useCallback(() => {
    runPresetAction(async () => {
      if (selectedPresetId && !presetDirty) {
        await api.applyPreset(selectedPresetId, true);
      } else {
        await api.flash();
      }
    });
  }, [selectedPresetId, presetDirty, runPresetAction]);

  const handleImportPresets = useCallback(
    (items: ImportedPreset[]) => {
      runPresetAction(async () => {
        const created: Preset[] = [];
        for (const item of items) {
          created.push(await api.createPreset(item.name, item.bands));
        }
        setPresets((prev) => [...prev, ...created]);
        if (created.length > 0) setSelectedPresetId(created[created.length - 1].id);
      });
    },
    [runPresetAction]
  );

  const handleExportPresets = useCallback(() => {
    const blob = new Blob([JSON.stringify({ version: 1, presets }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "trn-eq-presets.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [presets]);

  // ── Flash Save ──────────────────────────────────────────────────────
  const handleFlashSave = useCallback(async () => {
    setSaving(true);
    try {
      await api.flash();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }, []);

  // ── Reset EQ ────────────────────────────────────────────────────────
  // Flattens all ten bands and writes them out. This only clears the EQ
  // live -- it deliberately does not flash, so an accidental reset is
  // undone by re-selecting a preset (or unplugging before flashing).
  const handleResetEQ = useCallback(async () => {
    setResetting(true);
    const flat = defaultBands();
    try {
      for (let i = 0; i < flat.length; i++) {
        await api.setEQBand(i, flat[i]);
      }
      setBands(flat);
      setSelectedPresetId(null);
    } catch (e: any) {
      setError(e.message ?? "Reset failed");
    } finally {
      setResetting(false);
    }
  }, []);

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="app-shell">
      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-brand">
          <div className="header-logo">
            <span className="logo-icon">◈</span>
          </div>
          <div>
            <h1 className="header-title">TRN Black Pearl</h1>
            <p className="header-sub">TE-C Control Panel</p>
          </div>
        </div>

        <div className="header-nav">
          <TabNav active={tab} onChange={setTab} />
        </div>

        <div className="header-status">
          {firmware && <span className="firmware-badge mono">FW {firmware}</span>}
          <div className={`status-pill ${connected ? "online" : ""}`}>
            <div className={`status-dot ${connected ? "online" : "offline"}`} />
            <span className="status-label">{connected ? "Connected" : "Disconnected"}</span>
          </div>
          <button
            className={`btn-refresh ${refreshing ? "spinning" : ""}`}
            onClick={handleRefresh}
            disabled={refreshing}
            title="Check DAC connection"
            aria-label="Check DAC connection"
          >
            <span>⟳</span>
          </button>
        </div>
      </header>

      {/* ── Banners ── */}
      {error && (
        <div className="error-banner" onClick={() => setError(null)}>
          ⚠ {error} <span className="error-dismiss">×</span>
        </div>
      )}

      {!connected && !error && (
        <div className="offline-banner">
          <span>⚠ No DAC detected.</span>
          <span className="offline-hint">
            Plug in the Black Pearl, then refresh. Presets stay editable while offline.
          </span>
          <button onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? "Checking…" : "Refresh"}
          </button>
        </div>
      )}

      {/* ── Main layout ── */}
      <div className="app-body">
        {/* Left sidebar — device identity + global output */}
        <aside className="sidebar">
          <section className="panel">
            <h2 className="panel-title">Device Information</h2>
            <DeviceInfo
              firmware={firmware}
              connected={connected}
              resetting={resetting}
              onResetEQ={handleResetEQ}
            />
          </section>

          <section className="panel">
            <h2 className="panel-title">Output</h2>
            {/* On the EQ tab volume lives beside the graph, next to the
                headroom meter it feeds -- so it isn't repeated here. */}
            {tab !== "eq" && (
              <LevelSlider
                label="Volume"
                value={volume}
                min={0}
                max={100}
                unit="%"
                onChange={handleVolumeChange}
                onCommit={handleVolumeCommit}
                disabled={!connected}
              />
            )}
            <LevelSlider
              label="Balance"
              value={balance}
              min={-15}
              max={15}
              formatValue={(v) => (v === 0 ? "Center" : v < 0 ? `${Math.abs(v)} L` : `${v} R`)}
              onChange={handleBalanceCommit}
              onCommit={handleBalanceCommit}
              disabled={!connected}
              bipolar
            />
          </section>

          <section className="panel panel-actions">
            <button
              id="flash-save-btn"
              className="btn-primary"
              onClick={handleFlashSave}
              disabled={saving || !connected}
            >
              {saving ? "Saving…" : "💾  Save to Flash"}
            </button>
          </section>
        </aside>

        {/* Right area — tabbed content */}
        <main className="content-area">
          {tab === "eq" && (
            <div className="tab-panel">
              <section className="panel eq-panel">
                <div className="panel-head">
                  <div>
                    <h2 className="panel-title">Parametric EQ</h2>
                    <p className="panel-sub">10 bands · drag a node on the curve, or edit numerically below</p>
                  </div>
                </div>
                <PresetBar
                  presets={presets}
                  selectedId={selectedPresetId}
                  dirty={presetDirty}
                  busy={presetBusy}
                  connected={connected}
                  onSelect={handleSelectPreset}
                  onSaveAs={handleSavePresetAs}
                  onUpdate={handleUpdatePreset}
                  onRename={handleRenamePreset}
                  onDelete={handleDeletePreset}
                  onFlash={handleFlashPreset}
                  onImport={handleImportPresets}
                  onExport={handleExportPresets}
                  onError={setError}
                />
                <div className="eq-stage">
                  <EQGraph
                    bands={bands}
                    activeIndex={activeIdx}
                    onSelect={setActiveIdx}
                    onDrag={handleGraphDrag}
                    onCommit={handleGraphCommit}
                    disabled={!connected}
                  />
                  <VolumeColumn
                    volume={volume}
                    bands={bands}
                    disabled={!connected}
                    onChange={handleVolumeChange}
                    onCommit={handleVolumeCommit}
                  />
                </div>
                <div className="band-list-wrap">
                  <BandList
                    bands={bands}
                    activeIndex={activeIdx}
                    onSelect={setActiveIdx}
                    onChange={handleBandChange}
                    onCommit={handleBandCommit}
                    disabled={!connected}
                  />
                </div>
              </section>
            </div>
          )}

          {tab === "mic" && (
            <div className="tab-panel">
              <MicPanel
                micGain={micGain}
                disabled={!connected}
                onChange={setMicGain}
                onCommit={handleMicGainCommit}
              />
            </div>
          )}

          {tab === "filter" && (
            <div className="tab-panel">
              <FilterPanel
                filterMode={filterMode}
                gainMode={gainMode}
                ampMode={ampMode}
                balance={balance}
                disabled={!connected}
                onFilterMode={handleFilterMode}
                onGainMode={handleGainMode}
                onAmpMode={handleAmpMode}
                onBalance={handleBalanceCommit}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
