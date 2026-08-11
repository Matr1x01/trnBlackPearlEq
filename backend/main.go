// Command trncontrol-backend is the Go sidecar for the TRN Black Pearl
// (TE-C) control panel. It owns the HID connection and exposes a
// localhost-only HTTP/WebSocket API that the Tauri/React frontend
// talks to. It is launched and terminated by the Tauri shell (see
// src-tauri/src/main.rs) and never listens on anything but loopback.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"time"

	"trncontrol/api"
	"trncontrol/hidproto"
	"trncontrol/presets"
)

func main() {
	port := flag.Int("port", 47823, "loopback port to serve the API on")
	presetFile := flag.String("presets", "", "path to the EQ preset library (default: per-user config dir)")
	flag.Parse()

	// Exit with the desktop shell if we were launched by it.
	watchParent()

	if err := hidproto.InitHID(); err != nil {
		log.Fatalf("hid init: %v", err)
	}
	defer hidproto.ExitHID()

	// On desktop the device layer discovers the DAC itself. Android has no
	// hidraw access and pushes a transport in instead -- see backend/mobile.
	dev := hidproto.NewDevice(hidproto.HIDOpener)
	go connectLoop(dev)

	// A broken or unreadable preset file must not stop the control
	// panel from running; the API reports the problem per-request.
	store, err := presets.Open(*presetFile)
	if err != nil {
		log.Printf("preset library disabled: %v", err)
	} else {
		log.Printf("preset library: %s", store.Path())
	}

	srv := api.NewServer(dev, store)

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	log.Printf("trncontrol-backend listening on %s", addr)
	// Printed for the Tauri shell / dev script to confirm readiness on
	// a known port; also handy when running the sidecar standalone.
	fmt.Printf("READY %d\n", *port)

	if err := http.ListenAndServe(addr, api.WithCORS(srv.Handler())); err != nil {
		log.Fatalf("http server: %v", err)
	}
}

// connectLoop keeps trying to open the DAC, so the app works whether
// it's launched before or after the device is plugged in, and
// recovers automatically if it's unplugged and replugged.
func connectLoop(dev *hidproto.Device) {
	for {
		if !dev.IsOpen() {
			if err := dev.Open(); err != nil {
				time.Sleep(2 * time.Second)
				continue
			}
			log.Println("DAC connected")
		}
		time.Sleep(2 * time.Second)
	}
}
