//go:build !android

// Desktop transport: hidapi via go-hid, talking to the kernel's hidraw
// device. Excluded on Android, which has no hidraw access for unprivileged
// apps -- there the transport comes from Kotlin's USB Host API instead (see
// backend/mobile and android/).
//
// This file is the only place in the project that links against cgo/hidapi,
// which is what lets the rest of the backend cross-compile for Android
// unchanged.

package hidproto

import (
	"fmt"
	"time"

	hid "github.com/sstallion/go-hid"
)

// InitHID prepares the hidapi library. Call once at process start.
func InitHID() error { return hid.Init() }

// ExitHID releases hidapi's global state.
func ExitHID() { _ = hid.Exit() }

// HIDOpener opens the first attached Black Pearl. It satisfies Opener, so
// `NewDevice(HIDOpener)` gives a Device that discovers the DAC by itself.
func HIDOpener() (Transport, error) {
	d, err := hid.OpenFirst(VendorID, ProductID)
	if err != nil {
		return nil, fmt.Errorf("open %04x:%04x: %w", VendorID, ProductID, err)
	}
	return &hidTransport{d: d}, nil
}

type hidTransport struct{ d *hid.Device }

// go-hid's Write expects the report ID as buf[0], matching our packet
// layout already.
func (t *hidTransport) Write(p []byte) (int, error) { return t.d.Write(p) }

func (t *hidTransport) ReadWithTimeout(buf []byte, timeout time.Duration) (int, error) {
	n, err := t.d.ReadWithTimeout(buf, timeout)
	if err == hid.ErrTimeout {
		// Normalise to the package's own sentinel so the read loop stays
		// free of hidapi specifics.
		return 0, ErrReadTimeout
	}
	return n, err
}

func (t *hidTransport) Close() error { return t.d.Close() }
