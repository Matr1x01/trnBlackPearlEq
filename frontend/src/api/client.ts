// Client for the Go sidecar's local API. The sidecar always binds to
// 127.0.0.1 on a fixed port (see backend/main.go and
// src-tauri/src/main.rs -- keep BACKEND_PORT in sync if you change it).
const BASE = "http://127.0.0.1:47823";

export type FilterMode = "fast-ll" | "fast-pc" | "slow-ll" | "slow-pc" | "nos";
export type GainMode = "low" | "high";
export type AmpMode = "class-h" | "class-ab";
export type BandType = "PK" | "LS" | "HS";

export interface EQBand {
  type: BandType;
  freqHz: number;
  q: number;
  gainDb: number;
  enabled: boolean;
}

export interface Status {
  connected: boolean;
  firmware: string | null;
}

/** A named EQ configuration stored host-side by the sidecar. */
export interface Preset {
  id: string;
  name: string;
  /** Headphone or IEM this tuning targets. Empty when unset. */
  target: string;
  pinned: boolean;
  bands: EQBand[];
  createdAt: string;
  updatedAt: string;
  /** Stamped when applied to the device; null until first use. */
  lastUsedAt: string | null;
}

export interface PresetPatch {
  name?: string;
  target?: string;
  pinned?: boolean;
  bands?: EQBand[];
}

export const BAND_COUNT = 10;

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${path} failed with ${res.status}`);
  }
  return res.json();
}

export const api = {
  status: () => req<Status>("/api/status"),
  /** Makes one immediate attempt to open the DAC, then returns status. */
  reconnect: () => req<Status>("/api/reconnect", { method: "POST" }),

  getVolume: () => req<{ percent: number; db: number }>("/api/volume"),
  setVolume: (percent: number) =>
    req<{ percent: number }>("/api/volume", {
      method: "PUT",
      body: JSON.stringify({ Percent: percent }),
    }),

  getMicGain: () => req<{ db: number }>("/api/mic-gain"),
  setMicGain: (db: number) =>
    req<{ db: number }>("/api/mic-gain", { method: "PUT", body: JSON.stringify({ DB: db }) }),

  getBalance: () => req<{ value: number }>("/api/balance"),
  setBalance: (value: number) =>
    req<{ value: number }>("/api/balance", { method: "PUT", body: JSON.stringify({ Value: value }) }),

  getRegister: (name: "filter" | "gain" | "amp") => req<{ value: string }>(`/api/registers/${name}`),
  setRegister: (name: "filter" | "gain" | "amp", value: string) =>
    req<{ value: string }>(`/api/registers/${name}`, {
      method: "PUT",
      body: JSON.stringify({ Value: value }),
    }),

  getEQBand: (idx: number) => req<EQBand>(`/api/eq/${idx}`),
  setEQBand: (idx: number, band: EQBand) =>
    req<EQBand>(`/api/eq/${idx}`, { method: "PUT", body: JSON.stringify(band) }),

  latch: () => req<{ ok: boolean }>("/api/latch", { method: "POST" }),
  flash: () => req<{ ok: boolean }>("/api/flash", { method: "POST" }),

  listPresets: () => req<{ presets: Preset[] }>("/api/presets").then((r) => r.presets ?? []),
  createPreset: (name: string, bands: EQBand[], target = "") =>
    req<Preset>("/api/presets", {
      method: "POST",
      body: JSON.stringify({ name, bands, target }),
    }),
  /** Omit a field to leave it untouched: rename without resending bands, or vice versa. */
  updatePreset: (id: string, patch: PresetPatch) =>
    req<Preset>(`/api/presets/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  deletePreset: (id: string) =>
    req<{ ok: boolean }>(`/api/presets/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Writes all 10 bands to the DAC and latches them; flash also persists them. */
  applyPreset: (id: string, flash = false) =>
    req<{ ok: boolean; flashed: boolean; preset: Preset }>(
      `/api/presets/${encodeURIComponent(id)}/apply`,
      { method: "POST", body: JSON.stringify({ flash }) }
    ),
};

export type DeviceEvent = { type: "volume"; percent: number; db: number };

/** Subscribes to hardware-originated changes (e.g. physical volume buttons). */
export function subscribeEvents(onEvent: (ev: DeviceEvent) => void): () => void {
  const ws = new WebSocket(`ws://127.0.0.1:47823/api/events`);
  ws.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data));
    } catch {
      /* ignore malformed frames */
    }
  };
  return () => ws.close();
}
