# TRN Black Pearl Control Panel

This repository contains a DAC control panel for the TRN Black Pearl / TE-C device. It is built as a React frontend talking to a Go HID sidecar, with a Tauri packaging layer in `src-tauri`.

## Project Overview

- `backend/` - Go sidecar that manages the USB HID device and exposes a localhost HTTP/WebSocket API.
- `frontend/` - React + Vite UI that consumes the local API and renders controls for volume, balance, mic gain, DAC modes, and a 10-band parametric EQ.
- `src-tauri/` - Tauri packaging configuration and build script.
- `req.txt` - early project notes and protocol summary.

## Architecture

### Backend (`backend/`)

The backend is a Go command-line app in `backend/main.go`.

- Opens the TRN Black Pearl HID device using `github.com/sstallion/go-hid`.
- Runs `connectLoop` to retry opening the device every 2 seconds until connected.
- Starts an HTTP server on `127.0.0.1:47823`.
- Wraps API handlers with permissive CORS so the Tauri webview or local browser can access it.
- Prints `READY <port>` once the sidecar is listening.

The API handlers are defined in `backend/api/server.go` and expose:

- `GET /api/status` - connection state and firmware version
- `POST /api/reconnect` - make one immediate attempt to open the DAC, then return status
- `GET /api/volume` - current volume
- `PUT /api/volume` - set volume
- `GET /api/mic-gain` - current microphone gain
- `PUT /api/mic-gain` - set microphone gain
- `GET /api/balance` - current left/right balance
- `PUT /api/balance` - set balance
- `GET /api/registers/{filter|gain|amp}` - read DAC register state
- `PUT /api/registers/{filter|gain|amp}` - set DAC register state
- `GET /api/eq/{0-9}` - read one EQ band
- `PUT /api/eq/{0-9}` - write one EQ band
- `GET /api/presets` - list saved EQ presets
- `POST /api/presets` - create a preset from a name + 10 bands
- `GET /api/presets/{id}` - read one preset
- `PUT /api/presets/{id}` - rename a preset and/or overwrite its bands
- `DELETE /api/presets/{id}` - delete a preset
- `POST /api/presets/{id}/apply` - write all 10 bands to the DAC and latch; `{"flash": true}` also persists them
- `POST /api/latch` - apply pending live changes
- `POST /api/flash` - persist current settings to flash
- `GET /api/events` - WebSocket stream for device-originated events

The backend also includes `backend/api/events.go`:

- Upgrades `/api/events` to a WebSocket.
- Broadcasts volume change events when the device sends them.

### HID Protocol (`backend/hidproto/`)

The HID protocol implementation is in `backend/hidproto/`.

- `protocol.go` contains packet framing and command definitions.
- `device.go` manages the HID connection, a single read loop, caching of responses, and event subscriptions.
- `peq.go` encodes/decodes parametric EQ band requests and responses.
- `biquad.go` computes RBJ biquad coefficients matching the hardware DSP.

### Preset Library (`backend/presets/`)

The DAC holds only one live PEQ configuration, so the library of named
presets lives on the host:

- `store.go` is a file-backed, mutex-guarded collection of presets. Every
  mutation rewrites the whole file through a temp file + rename, so an
  interrupted write cannot corrupt the library.
- `band.go` validates and clamps bands before they are stored, so an
  imported or hand-edited file can never push nonsense into the biquad math.

The library defaults to `presets.json` in the per-user config directory
(`~/.config/trncontrol/presets.json` on Linux). Override it with
`-presets /path/to/file.json`. If the file cannot be opened the rest of
the app still runs; only the preset endpoints report the failure.

Key hardware identities:

- Vendor ID: `0x3302`
- Product ID: `0x43E8`

The device communicates using 64-byte HID reports with a header of `[ReportID, Type, Command, ...payload...]`.

### Frontend (`frontend/`)

The frontend is a React + Vite application.

- `frontend/src/App.tsx` is the main UI and state manager.
- `frontend/src/api/client.ts` contains the REST/WebSocket client for the backend.
- `frontend/src/dsp/biquad.ts` mirrors the Go biquad math for drawing the EQ response curve.
- `frontend/src/components/` contains UI components:
  - `BandList.tsx` - shows 10 EQ bands and allows editing.
  - `EQGraph.tsx` - plots the combined EQ curve.
  - `PresetBar.tsx` - select, save, rename, delete, import/export and flash EQ presets.
  - `LevelSlider.tsx` - reusable slider for volume/balance/mic gain.
  - `ToggleRow.tsx` - radio-group style toggles for DAC mode settings.

The frontend uses optimistic updates for controls and subscribes to device events on `/api/events`.

### Tauri Layer (`src-tauri/`)

The Tauri configuration exists in `src-tauri/`.

- `src-tauri/tauri.conf.json` configures packaging and dev behavior.
- `src-tauri/build.rs` runs `tauri_build::build()`.

Important note: the Tauri Rust application source directory `src-tauri/src/` is not present in this repository snapshot. That means the Tauri app cannot currently be built from this workspace as-is. The config is present, but the Rust entrypoint source appears to be missing.

## How It Works

1. The backend opens the HID device and listens on `127.0.0.1:47823`.
2. The frontend fetches current state from the sidecar and populates UI controls.
3. User actions call API endpoints to set volume, balance, mic gain, EQ bands, and DAC modes.
4. Writes to the device are often followed by a `latch` command to apply live changes.
5. `flash` saves the current configuration to device flash.
6. The frontend also listens to volume events from the device via WebSocket for physical control updates.
7. Selecting a saved preset loads it into the editor and pushes all 10 bands
   to the DAC live; flashing it is a separate action, so browsing presets
   never burns a flash cycle.

## Development Setup

### Prerequisites

- Go 1.22
- Node.js + npm
- Rust toolchain + `cargo` (for Tauri packaging)
- `tauri-cli` if you want to build the desktop package

### Install frontend dependencies

```bash
cd frontend
npm install
```

### Install backend dependencies

```bash
cd backend
go mod download
```

### Run frontend development server

```bash
cd frontend
npm run dev
```

The frontend dev server is configured to proxy `/api` requests to `http://127.0.0.1:47823` and to support WebSockets.

### Run backend sidecar

```bash
cd backend
go run ./...
```

Then open `http://localhost:5173` to use the UI.

### Build frontend

```bash
cd frontend
npm run build
```

### Build Tauri app

Because the Tauri `src-tauri/src/` source directory is missing, this step may not work until the Rust frontend launcher is restored.

```bash
cd src-tauri
cargo build --release
```

## Notes and Known Gaps

- The code currently has no `src-tauri/src/main.rs` or Tauri Rust entrypoint in the workspace.
- The backend listens only on loopback (`127.0.0.1`) for security, and the frontend assumes the same fixed port `47823`.
- The frontend uses optimistic updates. If the backend write fails, the UI may temporarily show an uncommitted state.

## Optional Commands

- `npm --prefix frontend run dev` - start frontend dev server
- `npm --prefix frontend run build` - build frontend assets
- `go run backend/main.go` - run the backend sidecar directly

## Repo Structure

```
backend/
  main.go
  api/
    server.go
    events.go
    errors.go
  hidproto/
    protocol.go
    device.go
    peq.go
    biquad.go
  presets/
    store.go
    band.go
    store_test.go
frontend/
  package.json
  tsconfig.json
  vite.config.ts
  src/
    App.tsx
    main.tsx
    api/client.ts
    dsp/biquad.ts
    components/
src-tauri/
  Cargo.toml
  build.rs
  tauri.conf.json
```

## Contact

Use this README as the central reference for how the app works and how to continue development. If you restore the missing Tauri source, the desktop packaging flow can be completed from `src-tauri/`.
