#!/usr/bin/env bash
# ---------------------------------------------------------------------
# Builds the Go backend into android/app/libs/trncontrol.aar.
#
# The Linux/macOS counterpart of build-backend.bat. Prerequisites are in
# android/README.md: Go, the Android NDK, and gomobile on PATH.
# ---------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/../backend"
OUT="$SCRIPT_DIR/app/libs/trncontrol.aar"

if ! command -v gomobile >/dev/null 2>&1; then
    echo "ERROR: gomobile is not on PATH." >&2
    echo "  go install golang.org/x/mobile/cmd/gomobile@latest" >&2
    echo "  gomobile init" >&2
    exit 1
fi

if [[ -z "${ANDROID_NDK_HOME:-}${ANDROID_NDK_ROOT:-}" ]]; then
    echo "ERROR: set ANDROID_NDK_HOME to your NDK, e.g." >&2
    echo "  export ANDROID_NDK_HOME=\$HOME/Android/Sdk/ndk/27.0.12077973" >&2
    exit 1
fi

mkdir -p "$SCRIPT_DIR/app/libs"

echo "Building trncontrol.aar (android/arm64, android/arm)..."
cd "$BACKEND_DIR"
gomobile bind \
    -target=android/arm64,android/arm \
    -androidapi 26 \
    -javapkg=dev.trncontrol.backend \
    -trimpath \
    -ldflags "-s -w" \
    -o "$OUT" \
    ./mobile

echo
echo "Wrote $OUT"
