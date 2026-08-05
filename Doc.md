# DAC Read/Write and PEQ Theory

This document explains how the TRN Black Pearl DAC is read from and written to, how the parametric EQ works, and what the other DAC settings do.

## 1. How the DAC is read and written

### USB/HID transport

The DAC communicates over USB HID. All messages are 64-byte HID reports, with the first bytes meaning:

- `ReportID` = `0x4B`
- `Type` = `0x01` for write, `0x80` for read
- `Command` = hardware command ID
- payload = command-specific bytes
- remaining bytes = padding to 64 bytes

The Go backend uses `github.com/sstallion/go-hid` to open the device and read/write reports.

### Request/response flow

The backend sends a packet and waits for a matching response from the device. It uses a single writer lock and a background reader loop to serialize HID I/O.

- Write packets are sent with `Device.Send(pkt)`.
- Read packets are sent with `Device.RequestSync(pkt, key, timeout)`.
- The reader loop caches responses by a derived key and also emits volume events.

If a request times out, the code retries once before returning an error.

### Read-only commands

- `CmdVersion` (`0x0C`) reads firmware version.
- `CmdFilter` (`0x11`) reads filter mode.
- `CmdGainMode` (`0x19`) reads gain mode.
- `CmdAmpMode` (`0x1D`) reads amplifier topology.
- `CmdGlobalGain` (`0x03`) reads output volume.
- `CmdMicGain` (`0x02`) reads microphone gain.
- `CmdBalance` (`0x16`) reads left or right balance attenuation.
- `CmdPEQValues` (`0x09`) reads one PEQ band.

### Write commands

- `CmdFilter` / `CmdGainMode` / `CmdAmpMode` write a single-byte register value.
- `CmdGlobalGain` writes a 16-bit signed volume value.
- `CmdMicGain` writes mic gain in dB.
- `CmdBalance` writes left and right attenuation separately.
- `CmdPEQValues` writes one EQ band.
- `CmdTempWrite` (`0x0A`) is the latch command: apply current buffered state live.
- `CmdFlashSave` (`0x01`) persists the current state to flash.

## 2. PEQ read/write details

### Reading a PEQ band

The backend calls `hidproto.ReadPEQPacket(idx)` with band index `0-9`. The device returns:

- `idx` in the response to confirm the band
- frequency in Hz
- Q factor as a fixed-point value
- gain in dB as a fixed-point signed value
- filter type (PK, LS, HS)
- active preset slot

The response is parsed by `hidproto.ParsePEQResponse`.

The backend stores the active preset slot from the read response in `Server.activeSlot`. This slot is echoed back when writing PEQ bands.

### Writing a PEQ band

The backend builds a full `CmdPEQValues` packet using `hidproto.WritePEQPacket(idx, band, activeSlot)`.

This packet includes:

- requested band index
- five float32 biquad coefficients: `b0, b1, b2, a1, a2`
- the band metadata the hardware expects: frequency, Q, gain, filter type
- the active slot value from the last read
- end marker byte

After sending the PEQ packet, the backend sends a `LatchPacket()` to apply the changes live.

### What is in the PEQ packet?

The hardware does not accept high-level EQ values directly. Instead it takes normalized biquad coefficients computed from the user-facing EQ parameters.

The coefficients are derived from the RBJ Audio EQ Cookbook formula:

- `b0, b1, b2, a1, a2` are the normalized filter coefficients
- `a0` is normalized to `1`
- the device receives these values as little-endian float32

These coefficients are computed in both Go and JavaScript so the UI can render a matching frequency response.

## 3. How PEQ works in this app

### Band model

Each EQ band has:

- `type`: `PK` (peaking), `LS` (low shelf), or `HS` (high shelf)
- `freqHz`: center/corner frequency
- `q`: quality factor (bandwidth)
- `gainDb`: gain in decibels
- `enabled`: whether the band is active

In the UI, a disabled band is represented by `gainDb == 0`.

### DSP math

The Go implementation in `backend/hidproto/biquad.go` computes the coefficients using:

- sample rate: `48000 Hz`
- gain conversion: `A = 10^(gain/40)`
- normalized frequency: `w0 = 2 * pi * freq / Fs`
- alpha = `sin(w0) / (2 * Q)`

For peaking filters (`PK`):

- `b0 = 1 + alpha*A`
- `b1 = -2*cos(w0)`
- `b2 = 1 - alpha*A`
- `a0 = 1 + alpha/A`
- `a1 = -2*cos(w0)`
- `a2 = 1 - alpha/A`

For shelf filters (`LS`/`HS`):

- the code uses the standard shelf coefficient formulas with `sqrt(A)`.

After coefficient calculation, the UI uses `combinedResponseDb` to sum each band's response in dB and display the combined EQ curve.

### UI behavior

- `frontend/src/App.tsx` loads all 10 bands on startup.
- The graph and band list are synchronized.
- Band edits are committed via `PUT /api/eq/{idx}`.
- The frontend uses optimistic updates, so it updates the UI before the backend reply arrives.

## 3b. Preset library

The hardware stores exactly one live PEQ configuration — there is no
command to enumerate or switch hardware preset banks. (`ActiveSlot` in a
PEQ read is a value the device wants echoed back on writes, not a
selectable bank.) So the library of named presets is kept host-side by
the sidecar.

### Storage

Presets are stored as a single JSON file, by default
`~/.config/trncontrol/presets.json` (`-presets` overrides the path):

```json
{
  "version": 1,
  "presets": [
    {
      "id": "p1785920088711635865-1",
      "name": "Bass Boost",
      "bands": [ { "type": "PK", "freqHz": 32, "q": 0.71, "gainDb": 4, "enabled": true }, ... ],
      "createdAt": "2026-08-05T08:54:48Z",
      "updatedAt": "2026-08-05T08:54:48Z"
    }
  ]
}
```

Rules the store enforces:

- A preset always holds exactly 10 bands, because a band's index *is* its
  hardware slot — applying a partial preset would leave stale bands behind.
- Frequency, Q and gain are clamped (20–20000 Hz, 0.05–20, ±30 dB) and
  unknown filter types are rejected, so an imported file cannot feed
  nonsense into the biquad math.
- Duplicate names get a ` (2)`, ` (3)` suffix so the dropdown never shows
  two identical labels.
- Writes go to a temp file and are renamed into place, so an interrupted
  write cannot truncate an existing library.

### Applying a preset

`POST /api/presets/{id}/apply` does what the UI would otherwise do ten
times over:

1. Read band 0 to refresh the cached active slot. A preset can be applied
   before the UI has read any band (for example right after the sidecar
   restarts), and the slot is only ever learned from a read.
2. For each band 0-9, build a `CmdPEQValues` write packet from the stored
   band and send it, pausing ~8 ms between bands so the device does not
   drop reports.
3. Send one `LatchPacket()` to apply the whole set live.
4. If the request body is `{"flash": true}`, also send `FlashSavePacket()`.

Selecting a preset in the UI applies it live only. Flashing is a separate,
explicit action, so switching between presets to compare them does not
consume flash write cycles.

## 4. Other DAC settings

### Volume

Volume is stored as a signed 16-bit raw value where raw/256.0 = dB.

- Minimum raw: `-9472`
- Maximum raw: `6440`
- The UI maps this range to `0-100%`.

Volume writes use `hidproto.WriteVolumePacket(raw)` and are followed by `LatchPacket()`.

### Mic Gain

Mic gain is a simple 8-bit signed dB value.

- `ReadMicGainPacket()` requests current mic gain.
- `WriteMicGainPacket(db)` sets the gain.

### Balance

The hardware stores left and right attenuation separately.

- `ReadBalancePacket(left)` reads left or right channel attenuation.
- `WriteBalancePacket(left, v)` encodes a value in `[-15, 15]`.
- The app writes both left and right values on balance changes.

Balance works by attenuating one channel more than the other.

### Filter Mode

Filter mode selects one of these DSP filter options:

- `fast-ll`
- `fast-pc`
- `slow-ll`
- `slow-pc`
- `nos`

These modes are hardware-specific digital filter settings on the DAC.

### Gain Mode

Gain mode selects the device gain stage:

- `low`
- `high`

### Amp Mode

Amplifier topology can be set to:

- `class-h`
- `class-ab`

These are hardware amplifier operating modes exposed by the device.

## 5. Packet and API mapping

| UI Action | API Endpoint | HID Command | Notes |
|---|---|---|---|
| Read status | `GET /api/status` | `CmdVersion` | reads firmware and connected state |
| Read volume | `GET /api/volume` | `CmdGlobalGain` | parses raw 16-bit volume |
| Set volume | `PUT /api/volume` | `CmdGlobalGain` + `Latch` | maps percent to raw dB |
| Read mic | `GET /api/mic-gain` | `CmdMicGain` | reads signed dB |
| Set mic | `PUT /api/mic-gain` | `CmdMicGain` | no latch needed |
| Read balance | `GET /api/balance` | `CmdBalance` x2 | reads left/right separately |
| Set balance | `PUT /api/balance` | `CmdBalance` x2 | writes both sides |
| Read filter/gain/amp | `GET /api/registers/...` | `CmdFilter`, `CmdGainMode`, `CmdAmpMode` | single-byte reads |
| Set register | `PUT /api/registers/...` | `CmdFilter`, `CmdGainMode`, `CmdAmpMode` | single-byte writes |
| Read EQ band | `GET /api/eq/{idx}` | `CmdPEQValues` | reads one band, updates `activeSlot` |
| Set EQ band | `PUT /api/eq/{idx}` | `CmdPEQValues` + `Latch` | sends coefficients + metadata |
| List presets | `GET /api/presets` | none | host-side library, works with no DAC attached |
| Save preset | `POST /api/presets` | none | validates and clamps the 10 bands |
| Rename / overwrite | `PUT /api/presets/{id}` | none | omit a field to leave it untouched |
| Delete preset | `DELETE /api/presets/{id}` | none | |
| Apply preset | `POST /api/presets/{id}/apply` | `CmdPEQValues` x10 + `Latch` (+ `CmdFlashSave`) | `{"flash": true}` also persists |
| Latch | `POST /api/latch` | `CmdTempWrite` | apply buffered settings live |
| Flash | `POST /api/flash` | `CmdFlashSave` | persist state to flash |

## 6. Practical rules for writing EQ

- Always use the active slot seen in the most recent PEQ read.
- Compute coefficients from the UI band values.
- If `enabled == false`, write `gainDb == 0` to the device so the band is effectively flat.
- Send `LatchPacket()` after volume or PEQ writes.
- Debounce `FlashSavePacket()` in the UI to avoid excessive flash cycling.
- When writing several bands in a row, space the packets out (~8 ms) and
  latch once at the end rather than after every band.

## 7. Summary

The app is a control surface, not an audio processor. It configures the DAC hardware by sending precise HID packets.

- UI state -> JSON API -> HID packet -> DAC
- Reads are cached by command key and matched by response payload
- EQ writes include both biquad coefficients and readable metadata
- A live latch command is required to apply many writes immediately
- Flash saves persist the buffer to the device

This documentation should help you understand exactly how the DAC is queried and controlled.
