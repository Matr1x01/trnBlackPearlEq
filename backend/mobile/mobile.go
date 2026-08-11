// Package mobile is the Android entry point to the control panel backend.
//
// It is compiled to an AAR with `gomobile bind` and called from Kotlin. The
// whole of api, presets and hidproto is reused unchanged -- Android differs
// from desktop in exactly two ways, both handled here:
//
//   - There is no hidraw access, so the app cannot discover or open the DAC
//     itself. Kotlin owns USB enumeration and permission through the USB Host
//     API and hands the open pipe in via AttachDevice.
//   - There is no browser to point at a loopback port, so this server also
//     serves the built frontend. Same origin as the API, which keeps the
//     WebView clear of both CORS and mixed-content rules.
//
// Everything crossing the gomobile boundary sticks to the types it binds
// cleanly: string, int, bool, []byte, error, and interfaces declared here.
package mobile

import (
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"trncontrol/api"
	"trncontrol/hidproto"
	"trncontrol/presets"
)

// USBTransport is implemented in Kotlin over UsbDeviceConnection. It is the
// Android counterpart of the hidraw transport used on desktop.
//
// Contract, which the Kotlin side must honour:
//
//   - Write sends one 64-byte report; p[0] is the report ID.
//   - Read returns the next report, or an EMPTY slice if timeoutMs elapsed
//     with nothing to read. A timeout is normal and must not be an error --
//     the read loop polls continuously. Reserve errors for a genuinely dead
//     connection, since that is what triggers teardown and reconnect.
//   - Close is idempotent and may be called from any goroutine.
type USBTransport interface {
	Write(p []byte) error
	Read(timeoutMs int) ([]byte, error)
	Close() error
}

// Logger receives backend log lines so they can be forwarded to logcat.
// Go's log output does not reach logcat from a bound library, so without
// this the backend is silent on device.
type Logger interface {
	Log(msg string)
}

var (
	mu       sync.Mutex
	dev      *hidproto.Device
	listener net.Listener
	server   *http.Server
	started  bool
)

// SetLogger routes backend logging to the host application. Call before
// Start to catch startup messages.
func SetLogger(l Logger) {
	if l == nil {
		return
	}
	log.SetFlags(0)
	log.SetOutput(writerFunc(func(p []byte) (int, error) {
		l.Log(string(p))
		return len(p), nil
	}))
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// Start brings up the HTTP server on a free loopback port and returns that
// port. filesDir is the app's private storage, where the preset library is
// kept; webRoot is a directory holding the built frontend (index.html and
// its assets), which the Kotlin side extracts from the APK's assets.
//
// The port is chosen by the OS rather than fixed at 47823 as on desktop:
// an Android device may have anything already bound, and a collision would
// be an unexplainable failure on a user's phone.
func Start(filesDir string, webRoot string) (int, error) {
	mu.Lock()
	defer mu.Unlock()
	if started {
		return portOf(listener), nil
	}
	if filesDir == "" {
		return 0, errors.New("mobile: filesDir must not be empty")
	}

	// No opener: on Android the transport arrives through AttachDevice.
	dev = hidproto.NewDevice(nil)

	// A broken or unreadable preset file must not stop the control panel
	// from running; the API reports the problem per-request.
	store, err := presets.Open(filepath.Join(filesDir, "presets.json"))
	if err != nil {
		log.Printf("preset library disabled: %v", err)
		store = nil
	}

	srv := api.NewServer(dev, store)

	root := http.NewServeMux()
	root.Handle("/api/", srv.Handler())
	if webRoot != "" {
		root.Handle("/", noCache(http.FileServer(http.Dir(webRoot))))
	}

	// Loopback only, exactly as on desktop: nothing here should be
	// reachable from the network.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("listen: %w", err)
	}
	listener = ln
	server = &http.Server{Handler: api.WithCORS(root)}
	started = true

	go func() {
		if err := server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("http server: %v", err)
		}
	}()

	port := portOf(ln)
	log.Printf("trncontrol backend listening on 127.0.0.1:%d", port)
	return port, nil
}

// AttachDevice adopts a USB connection opened by the host application,
// typically after the user grants USB permission or the DAC is plugged in.
func AttachDevice(t USBTransport) error {
	mu.Lock()
	d := dev
	mu.Unlock()
	if d == nil {
		return errors.New("mobile: Start has not been called")
	}
	if t == nil {
		return errors.New("mobile: transport must not be nil")
	}
	return d.Attach(&androidTransport{t: t})
}

// DetachDevice drops the current connection, e.g. on USB detach. Safe to
// call when nothing is attached.
func DetachDevice() {
	mu.Lock()
	d := dev
	mu.Unlock()
	if d != nil {
		d.Close()
	}
}

// IsDeviceAttached reports whether the backend currently holds a connection.
func IsDeviceAttached() bool {
	mu.Lock()
	d := dev
	mu.Unlock()
	return d != nil && d.IsOpen()
}

// Stop shuts the server down and releases the device. The app may call
// Start again afterwards.
func Stop() {
	mu.Lock()
	defer mu.Unlock()
	if !started {
		return
	}
	if dev != nil {
		dev.Close()
		dev = nil
	}
	if server != nil {
		_ = server.Close()
		server = nil
	}
	listener = nil
	started = false
}

func portOf(ln net.Listener) int {
	if ln == nil {
		return 0
	}
	if addr, ok := ln.Addr().(*net.TCPAddr); ok {
		return addr.Port
	}
	return 0
}

// noCache keeps the WebView from serving a stale UI after an app update.
// The assets are on local disk, so there is nothing to save by caching them.
func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// androidTransport adapts the gomobile-friendly USBTransport to the
// interface the device layer expects. The shapes differ deliberately: Java
// has no natural way to return a distinguished timeout error across the
// binding, so the Kotlin side signals a timeout with an empty read and this
// translates it into the sentinel the read loop understands.
type androidTransport struct {
	t USBTransport
}

func (a *androidTransport) Write(p []byte) (int, error) {
	if err := a.t.Write(p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (a *androidTransport) ReadWithTimeout(buf []byte, timeout time.Duration) (int, error) {
	b, err := a.t.Read(int(timeout / time.Millisecond))
	if err != nil {
		return 0, err
	}
	if len(b) == 0 {
		return 0, hidproto.ErrReadTimeout
	}
	return copy(buf, b), nil
}

func (a *androidTransport) Close() error { return a.t.Close() }
