package hidproto

import (
	"errors"
	"fmt"
	"sync"
	"time"

	hid "github.com/sstallion/go-hid"
)

var ErrNotConnected = errors.New("hidproto: device not connected")
var ErrTimeout = errors.New("hidproto: no response from device")

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

// Device manages the HID connection and serializes all I/O through a
// single background read loop, mirroring the locking strategy of the
// reference implementation (one open handle, one writer at a time).
type Device struct {
	writeMu sync.Mutex
	dev     *hid.Device

	cacheMu sync.RWMutex
	cache   map[string]cacheEntry

	volSubMu sync.Mutex
	volSubs  []chan VolumeEvent

	stopCh chan struct{}
}

func NewDevice() *Device {
	return &Device{cache: make(map[string]cacheEntry)}
}

// Open finds and opens the DAC's HID interface and starts the
// background read loop. Safe to call again after Close or after the
// device was unplugged.
func (d *Device) Open() error {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()

	if d.dev != nil {
		return nil
	}
	dev, err := hid.OpenFirst(VendorID, ProductID)
	if err != nil {
		return fmt.Errorf("open HID device: %w", err)
	}
	d.dev = dev
	d.stopCh = make(chan struct{})
	go d.readLoop(dev, d.stopCh)
	return nil
}

func (d *Device) Close() {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	if d.dev == nil {
		return
	}
	close(d.stopCh)
	d.dev.Close()
	d.dev = nil
}

func (d *Device) IsOpen() bool {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	return d.dev != nil
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
	dev := d.dev
	d.writeMu.Unlock()
	if dev == nil {
		return ErrNotConnected
	}
	// go-hid's Write expects the report ID as buf[0], matching our
	// packet layout already.
	_, err := dev.Write(pkt)
	if err != nil {
		// A write failure (as opposed to a read timeout) means the
		// device is gone -- drop the handle immediately so IsOpen()
		// reflects reality and connectLoop retries, rather than
		// leaving every subsequent call to time out against a dead
		// handle.
		d.handleDisconnect(dev)
	}
	return err
}

// handleDisconnect clears the active connection and closes dev, but
// only if dev is still the current handle -- a concurrent Open() may
// have already replaced it (e.g. a fast unplug/replug), in which case
// this must not tear down the new connection.
func (d *Device) handleDisconnect(dev *hid.Device) {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	if d.dev != dev {
		return
	}
	d.dev = nil
	dev.Close()
}

// readLoop continuously reads incoming reports, updates the response
// cache keyed by command, and broadcasts volume changes. It exits once
// the device is unplugged or otherwise stops responding, at which
// point connectLoop takes over retrying the connection.
func (d *Device) readLoop(dev *hid.Device, stop chan struct{}) {
	buf := make([]byte, ReportSize)
	for {
		select {
		case <-stop:
			return
		default:
		}
		n, err := dev.ReadWithTimeout(buf, 250*time.Millisecond)
		if err == hid.ErrTimeout {
			continue
		}
		if err != nil {
			d.handleDisconnect(dev)
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
