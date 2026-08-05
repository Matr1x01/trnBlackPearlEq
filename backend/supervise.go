package main

import (
	"io"
	"log"
	"os"
)

// SuperviseEnv is set by the desktop shell when it launches this program as
// a managed sidecar. See src-tauri/src/lib.rs.
const SuperviseEnv = "TRNCONTROL_SUPERVISED"

// watchParent shuts the sidecar down when its supervisor goes away.
//
// The desktop shell kills this process on a clean quit, but a crash or a
// SIGKILL gives it no chance to. An orphaned backend keeps both the USB
// device and port 47823, so the *next* launch fails to bind and the app
// looks broken. When the parent dies, its end of our stdin pipe closes,
// which shows up here as EOF.
//
// This is gated behind the env var on purpose: run standalone from a
// terminal or under a service manager and stdin may legitimately be
// closed, empty, or /dev/null, which would otherwise exit immediately.
func watchParent() {
	if os.Getenv(SuperviseEnv) == "" {
		return
	}
	go func() {
		// Blocks until the write end of the pipe closes.
		_, _ = io.Copy(io.Discard, os.Stdin)
		log.Println("supervisor exited; shutting down")
		os.Exit(0)
	}()
}
