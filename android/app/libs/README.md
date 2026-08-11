# Generated — do not commit

`trncontrol.aar` goes here. It is the Go backend (`backend/mobile` plus
`api`, `presets` and `hidproto`) built by `gomobile bind`, and it is
gitignored because it is a ~8 MB build artefact, not source.

Produce it with:

```bat
..\..\build-backend.bat
```

or, on Linux/macOS:

```bash
../../build-backend.sh
```

Re-run after any change under `backend/` — Gradle has no way to tell that the
AAR is out of date.
