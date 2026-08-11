package hidproto

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

var ErrNotConnected = errors.New("hidproto: device not connected")
var ErrTimeout = errors.New("hidproto: no response from device")

// ErrReadTimeout is what a Transport returns when a read elapsed without a
// report arriving. It is an ordinary, expected outcome -- the read loop polls
// with a short timeout -- and must be distinguished from a real I/O failure,
// which is taken as the device having gone away.
var ErrReadTimeout = errors.New("hidproto: read timed out")

// ErrNoOpener is returned by Open on platforms where transports are pushed in
// from outside (Android) rather than discovered by this package.
var ErrNoOpener = errors.New("hidproto: no transport opener configured")

// Transport is the byte pipe to the DAC: one 64-byte HID report per call, in
// each direction. Everything above it -- packet framing, the response cache,
// request correlation -- is platform independent, so porting to a system with
// a different USB stack means implementing this and nothing else.
//
// On desktop it is hidapi via go-hid (see transport_hid.go). On Android there
// is no hidraw access, so it is implemented in Kotlin against the USB Host
// API and handed in through the mobile package.
//
// Implementations must be safe for one concurrent reader and one concurrent
// writer: the read loop and the request path run on different goroutines.
type Transport interface {
	// Write sends one report. p[0] is the report ID.
	Write(p []byte) (int, error)
	// ReadWithTimeout fills buf with the next report, returning
	// ErrReadTimeout if none arrived in time.
	ReadWithTimeout(buf []byte, timeout time.Duration) (int, error)
	Close() error
}

// Opener discovers and opens the device. Nil on platforms that cannot
// enumerate USB themselves.
type Opener func() (Transport, error)

type cacheEntry struct {
	raw []byte
	at  time.Time
}

// VolumeEvent is broadcast whenever the device's volume changes,
// whether from a host write or a physical button press.
type VolumeEvent struct {
	RawVolume int16
	Percent   int
}

// Device manages the connection and serializes all I/O through a
// single background read loop, mirroring the locking strategy of the
// reference implementation (one open handle, one writer at a time).
type Device struct {
	writeMu sync.Mutex
	tr      Transport
	open    Opener
	// gen identifies the current connection. A read loop carries the gen it
	// was started for, so a loop belonging to a superseded connection cannot
	// tear down the one that replaced it. Comparing Transport values
	// directly would work too, but only for comparable dynamic types --
	// this holds for any implementation.
	gen uint64

	cacheMu sync.RWMutex
	cache   map[string]cacheEntry

	volSubMu sync.Mutex
	volSubs  []chan VolumeEvent

	stopCh chan struct{}
}

// NewDevice returns a closed Device. open may be nil, in which case the
// caller is expected to supply transports through Attach.
func NewDevice(open Opener) *Device {
	return &Device{open: open, cache: make(map[string]cacheEntry)}
}

// Open discovers and opens the DAC, then starts the background read loop.
// Safe to call again after Close or after the device was unplugged.
func (d *Device) Open() error {
	d.writeMu.Lock()
	if d.tr != nil {
		d.writeMu.Unlock()
		return nil
	}
	open := d.open
	d.writeMu.Unlock()

	if open == nil {
		return ErrNoOpener
	}
	// Opening happens outside the lock: discovery can block, and holding
	// writeMu through it would stall every in-flight request.
	tr, err := open()
	if err != nil {
		return fmt.Errorf("open HID device: %w", err)
	}
	return d.Attach(tr)
}

// Attach adopts an already-open transport. This is the entry point on
// platforms where the host application owns USB enumeration and permission
// (Android), rather than this package discovering the device itself.
func (d *Device) Attach(tr Transport) error {
	if tr == nil {
		return ErrNotConnected
	}
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	if d.tr != nil {
		// Already connected; the caller raced with another attach. Close the
		// surplus transport rather than leaking it.
		go tr.Close()
		return nil
	}
	d.gen++
	d.tr = tr
	d.stopCh = make(chan struct{})
	go d.readLoop(tr, d.gen, d.stopCh)
	return nil
}

func (d *Device) Close() {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	if d.tr == nil {
		return
	}
	close(d.stopCh)
	d.tr.Close()
	d.tr = nil
	d.gen++
}

func (d *Device) IsOpen() bool {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	return d.tr != nil
}

// Subscribe registers a channel that receives every volume change
// (host- or hardware-originated). The caller should read from it
// promptly; sends are non-blocking and will drop if the channel is
// full.
func (d *Device) Subscribe() chan VolumeEvent {
	ch := make(chan VolumeEvent, 8)
	d.volSubMu.Lock()
	d.volSubs = append(d.volSubs, ch)
	d.volSubMu.Unlock()
	return ch
}

func (d *Device) broadcastVolume(ev VolumeEvent) {
	d.volSubMu.Lock()
	defer d.volSubMu.Unlock()
	for _, ch := range d.volSubs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// send writes a single 64-byte report. Safe for concurrent use.
func (d *Device) send(pkt []byte) error {
	d.writeMu.Lock()
	tr, gen := d.tr, d.gen
	d.writeMu.Unlock()
	if tr == nil {
		return ErrNotConnected
	}
	_, err := tr.Write(pkt)
	if err != nil {
		// A write failure (as opposed to a read timeout) means the
		// device is gone -- drop the handle immediately so IsOpen()
		// reflects reality and the caller's reconnect logic retries,
		// rather than leaving every subsequent call to time out
		// against a dead handle.
		d.handleDisconnect(gen)
	}
	return err
}

// handleDisconnect tears down the connection identified by gen, but only if
// it is still the current one -- a concurrent Attach may have already
// replaced it (e.g. a fast unplug/replug), in which case this must not tear
// down the new connection.
func (d *Device) handleDisconnect(gen uint64) {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	if d.gen != gen || d.tr == nil {
		return
	}
	close(d.stopCh)
	d.tr.Close()
	d.tr = nil
	d.gen++
}

// readLoop continuously reads incoming reports, updates the response
// cache keyed by command, and broadcasts volume changes. It exits once
// the device is unplugged or otherwise stops responding, at which
// point the caller's reconnect logic takes over.
func (d *Device) readLoop(tr Transport, gen uint64, stop chan struct{}) {
	buf := make([]byte, ReportSize)
	for {
		select {
		case <-stop:
			return
		default:
		}
		n, err := tr.ReadWithTimeout(buf, 250*time.Millisecond)
		if errors.Is(err, ErrReadTimeout) {
			continue
		}
		if err != nil {
			d.handleDisconnect(gen)
			return
		}
		if n == 0 {
			continue
		}
		raw := make([]byte, n)
		copy(raw, buf[:n])
		if len(raw) < 3 || raw[0] != ReportID || raw[1] != TypeRead {
			continue
		}
		key := cacheKeyFor(raw)
		if key == "" {
			continue
		}
		d.cacheMu.Lock()
		d.cache[key] = cacheEntry{raw: raw, at: time.Now()}
		d.cacheMu.Unlock()

		if key == "volume" {
			if v, err := ParseVolume(raw); err == nil {
				d.broadcastVolume(VolumeEvent{RawVolume: v, Percent: VolumeRawToPercent(v)})
			}
		}
	}
}

// cacheKeyFor derives a cache key from a decoded response, mirroring
// the reference implementation's on_data dispatch.
func cacheKeyFor(raw []byte) string {
	cmd := raw[2]
	switch cmd {
	case CmdVersion:
		return "version"
	case CmdPEQValues:
		if len(raw) < 37 {
			return ""
		}
		return fmt.Sprintf("peq:%d", raw[5])
	case CmdGlobalGain:
		return "volume"
	case CmdBalance:
		if len(raw) < 5 {
			return ""
		}
		if raw[4] == 0x01 {
			return "balance:l"
		}
		return "balance:r"
	case CmdMicGain:
		if len(raw) >= 4 && raw[3] == 0x02 {
			return "micgain"
		}
		return ""
	default:
		// Covers CmdFilter, CmdGainMode, CmdAmpMode, and any other
		// single-byte register we haven't named explicitly.
		return fmt.Sprintf("reg:0x%02x", cmd)
	}
}

// RequestSync sends pkt and waits up to timeout for a cache entry
// under key to be updated after the send. Retries the send once on
// timeout, matching the reference implementation's two-attempt policy.
func (d *Device) RequestSync(pkt []byte, key string, timeout time.Duration) ([]byte, error) {
	for attempt := 0; attempt < 2; attempt++ {
		since := time.Now()
		if err := d.send(pkt); err != nil {
			return nil, err
		}
		deadline := time.Now().Add(timeout)
		for time.Now().Before(deadline) {
			d.cacheMu.RLock()
			entry, ok := d.cache[key]
			d.cacheMu.RUnlock()
			if ok && entry.at.After(since) {
				return entry.raw, nil
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	return nil, ErrTimeout
}

// Send is the fire-and-forget path for writes that don't need a
// correlated response (volume/EQ writes followed by a Latch call).
func (d *Device) Send(pkt []byte) error {
	return d.send(pkt)
}
