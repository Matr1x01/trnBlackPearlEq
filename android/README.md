# Black Pearl Control — Android

An Android port of the control panel, for using the DAC plugged straight into
a phone over USB-C (OTG).

## How it works

```
┌─────────────────────────────────────────────┐
│ MainActivity                                │
│  ├─ WebView ──► http://127.0.0.1:<port>/    │  the same React UI as desktop
│  └─ DacConnectionManager                    │  permission + attach/detach
│        │                                    │
│        │ UsbHidTransport (Kotlin)           │  USB Host API
│        ▼                                    │
│  ┌──────────────────────────────────────┐   │
│  │ trncontrol.aar  (gomobile)           │   │
│  │   mobile → api → presets → hidproto  │   │  unchanged Go, shared with desktop
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

Three things are worth knowing:

**The protocol code is not duplicated.** `hidproto`, `presets` and `api` are
the same packages the desktop sidecar runs, compiled for `android/arm64` by
`gomobile bind`. Only the byte pipe differs, because Android gives
unprivileged apps no `hidraw` access — so `hidproto.Transport` is implemented
in Kotlin over the USB Host API instead of hidapi. Desktop keeps its hidapi
implementation in `transport_hid.go`, which carries `//go:build !android` and
is the only cgo in the project.

**The UI is not duplicated either.** Gradle copies `frontend/dist` into the
APK's assets at build time, the app unpacks it to private storage on first
launch, and the Go server serves it. That makes the UI same-origin with the
API, which is what keeps the WebView clear of both CORS and mixed-content
blocking. The frontend is told to use relative URLs by the `?api=same-origin`
query parameter (see `frontend/src/api/client.ts`).

**Only the HID interface is claimed.** The Black Pearl is a composite device:
USB Audio Class interfaces plus a vendor HID one. The app claims the HID
interface alone, so Android keeps routing audio to the DAC while the app
reconfigures it.

## Prerequisites (Windows)

| Tool | Notes |
|---|---|
| Android Studio | Easiest source of the SDK, NDK and a working Gradle wrapper |
| Android SDK 35 + build-tools | Via the SDK Manager |
| Android NDK | Any recent r26/r27. Required by `gomobile` |
| Go 1.22+ | `go version` |
| Node 18+ | To build the frontend |
| A phone with USB OTG | **The emulator cannot do USB host passthrough** |

```bat
go install golang.org/x/mobile/cmd/gomobile@latest
gomobile init
set ANDROID_NDK_HOME=%LOCALAPPDATA%\Android\Sdk\ndk\27.0.12077973
```

Make sure `%USERPROFILE%\go\bin` is on `PATH` so `gomobile` resolves.

## Build

**1. Build the frontend** (produces `frontend/dist`, which Gradle copies in):

```bat
cd frontend
npm install
npm run build
```

**2. Build the Go backend into an AAR:**

```bat
cd ..\android
build-backend.bat
```

Writes `android/app/libs/trncontrol.aar` (~8 MB, two ABIs). Re-run this
whenever anything under `backend/` changes — Gradle cannot know the AAR is
stale.

> If it fails mentioning `golang.org/x/mobile`, run `go get
> golang.org/x/mobile/bind` inside `backend/` once and retry.

**3. Build the APK:**

Open `android/` in Android Studio and hit Run, or from the command line:

```bat
gradlew.bat assembleDebug
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

> The Gradle wrapper JAR is not committed. Android Studio creates it when it
> first opens the project; without Studio, run `gradle wrapper` once using a
> system Gradle 8.9+.

## Running it

Plug the DAC into the phone. Android should offer to open the app — that
comes from the `USB_DEVICE_ATTACHED` filter matching VID `0x3302` / PID
`0x43E8` in `res/xml/device_filter.xml` (declared in decimal there, as the
manifest filter rejects hex). Tick "use by default" and the permission prompt
stops appearing.

Watch what it is doing:

```bat
adb logcat -s TRNMain TRNUsb TRNUsbHid TRNBackend
```

`TRNBackend` carries the Go logs, routed through `Mobile.setLogger` — Go's
`log` output does not otherwise reach logcat from a bound library.

Because the DAC occupies the phone's only USB port, use **wireless ADB** for
anything beyond a single install:

```bat
adb pair <phone-ip>:<pair-port>
adb connect <phone-ip>:<port>
```

## Verifying the transport before trusting the UI

If the app starts but nothing responds, check the layer that is actually new.
Everything above `UsbHidTransport` is code the desktop build already runs.

The cheapest end-to-end proof is a firmware read: the app's first HTTP call is
`/api/status`, which sends `4B 80 0C 00` and expects the version string back.
Seeing `firmware "0.6"` in the UI header means framing, endpoints, claiming
and the whole Go stack are all working.

### Troubleshooting

**"could not claim HID interface"** — the kernel HID driver would not release
it. `claimInterface(intf, force = true)` is already used, which is normally
enough. If a particular ROM refuses, there is no workaround short of root.

**Writes succeed, reads always time out** — the device may have no interrupt
OUT endpoint, so writes are going out over `SET_REPORT` while replies come
back on the IN endpoint. That path is implemented; check the `claimed HID
interface` log line to see which endpoints were found.

**Nothing works and reads return garbage** — the one framing assumption worth
questioning is numbered reports. `UsbHidTransport` sends the 64-byte buffer
verbatim, report ID `0x4B` at index 0, matching hidapi on Linux and pywinusb
on Windows. If this device turns out not to use numbered reports, strip byte 0
before the transfer and pad to 64.

**App opens but the screen is blank** — the web UI did not unpack. Check for
`unpacked web UI to ...` in logcat, and confirm `frontend/dist/index.html`
existed at build time. The Gradle build fails loudly if it did not.

## Not done yet

- Signing config for release builds — debug only so far.
- No foreground service, so the backend stops when the activity is destroyed.
  Fine for a control panel you open, adjust and close; it would need one to
  keep syncing physical volume-button presses in the background.
- `armeabi-v7a` and `arm64-v8a` only. Add `android/amd64` to the bind targets
  for an x86 emulator, though without USB host it can only exercise the UI and
  the preset library.
