// Package hidproto implements the TRN Black Pearl (TE-C) / TTGK TE-C
// HID control protocol, ported from a reverse-engineered reference
// implementation. All packets are 64-byte HID reports framed as:
//
//	[ReportID, Type, Command, ...payload..., 0x00 padding to 64 bytes]
package hidproto

import (
	"encoding/binary"
	"fmt"
	"math"
)

const (
	VendorID  = 0x3302
	ProductID = 0x43E8

	ReportSize = 64
	ReportID   = 0x4B

	TypeWrite = 0x01
	TypeRead  = 0x80
	TypeEnd   = 0x00
)

// Command IDs
const (
	CmdMicGain    = 0x02 // read/write mic gain
	CmdGlobalGain = 0x03 // read/write output volume
	CmdPEQValues  = 0x09 // read/write one parametric EQ band
	CmdFlashSave  = 0x01 // persist current buffer to flash
	CmdTempWrite  = 0x0A // latch buffered changes live (no flash write)
	CmdVersion    = 0x0C // read firmware version string
	CmdFilter     = 0x11 // digital filter mode
	CmdGainMode   = 0x19 // gain mode (low/high)
	CmdAmpMode    = 0x1D // amplifier topology
	CmdBalance    = 0x16 // per-channel balance attenuation
)

// Volume scaling. Raw values are a fixed-point representation where
// raw/256.0 == dB.
const (
	VolMinRaw    int16 = -9472
	VolMaxRaw    int16 = 6440
	UnitsPerDB         = 256.0
)

// FilterMode / GainMode / AmpMode are the known enumerations for the
// corresponding hardware registers.
var FilterModeNames = map[byte]string{
	0x01: "fast-ll",
	0x02: "fast-pc", // recommended default
	0x03: "slow-ll",
	0x04: "slow-pc",
	0x05: "nos",
}

var GainModeNames = map[byte]string{
	0x00: "low",
	0x01: "high",
}

var AmpModeNames = map[byte]string{
	0x00: "class-h",
	0x01: "class-ab",
}

// FilterType is the PEQ band shape.
type FilterType byte

const (
	FilterPeaking   FilterType = 0x02 // "PK"
	FilterLowShelf  FilterType = 0x03 // "LS"
	FilterHighShelf FilterType = 0x04 // "HS"
)

func FilterTypeFromString(s string) (FilterType, error) {
	switch s {
	case "PK":
		return FilterPeaking, nil
	case "LS":
		return FilterLowShelf, nil
	case "HS":
		return FilterHighShelf, nil
	default:
		return 0, fmt.Errorf("unknown filter type %q", s)
	}
}

func (t FilterType) String() string {
	switch t {
	case FilterPeaking:
		return "PK"
	case FilterLowShelf:
		return "LS"
	case FilterHighShelf:
		return "HS"
	default:
		return "PK"
	}
}

// newReport returns a zeroed 64-byte report with the report ID and
// type/command header already populated.
func newReport(typ byte, cmd byte) []byte {
	r := make([]byte, ReportSize)
	r[0] = ReportID
	r[1] = typ
	r[2] = cmd
	return r
}

// --- Simple register reads (firmware version, filter/gain/amp mode) ---

// ReadRegisterPacket builds a READ request for a single-byte register
// (filter mode, gain mode, amp mode, or firmware version).
func ReadRegisterPacket(cmd byte) []byte {
	p := newReport(TypeRead, cmd)
	p[3] = TypeEnd
	return p
}

// WriteRegisterPacket builds a WRITE request setting a single-byte
// register to value.
func WriteRegisterPacket(cmd byte, value byte) []byte {
	p := newReport(TypeWrite, cmd)
	p[3] = 0x01 // payload length
	p[4] = value
	return p
}

// ParseFirmwareVersion extracts the null-terminated ASCII version
// string from a CmdVersion READ response.
func ParseFirmwareVersion(resp []byte) (string, error) {
	if len(resp) < 5 || resp[0] != ReportID || resp[2] != CmdVersion {
		return "", fmt.Errorf("not a firmware version response")
	}
	end := 4
	for end < len(resp) && resp[end] != 0x00 {
		end++
	}
	return string(resp[4:end]), nil
}

// ParseByteRegister extracts a single-byte payload (filter/gain/amp
// mode) from a READ response.
func ParseByteRegister(resp []byte) (byte, error) {
	if len(resp) < 5 || resp[0] != ReportID {
		return 0, fmt.Errorf("short or malformed response")
	}
	return resp[4], nil
}

// --- Volume ---

func ReadVolumePacket() []byte {
	p := newReport(TypeRead, CmdGlobalGain)
	p[3] = TypeEnd
	return p
}

func WriteVolumePacket(raw int16) []byte {
	p := newReport(TypeWrite, CmdGlobalGain)
	p[3] = 0x03
	binary.LittleEndian.PutUint16(p[4:6], uint16(raw))
	p[6] = 0x00
	return p
}

// ParseVolume extracts the raw signed 16-bit volume from a
// CmdGlobalGain READ response.
func ParseVolume(resp []byte) (int16, error) {
	if len(resp) < 6 || resp[0] != ReportID || resp[2] != CmdGlobalGain {
		return 0, fmt.Errorf("not a volume response")
	}
	return int16(binary.LittleEndian.Uint16(resp[4:6])), nil
}

func VolumeRawToDB(raw int16) float64 { return float64(raw) / UnitsPerDB }
func VolumeDBToRaw(db float64) int16  { return int16(math.Round(db * UnitsPerDB)) }

// VolumeRawToPercent maps the raw hardware range onto 0-100 for UI sliders.
func VolumeRawToPercent(raw int16) int {
	pct := float64(raw-VolMinRaw) / float64(VolMaxRaw-VolMinRaw) * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return int(math.Round(pct))
}

func VolumePercentToRaw(pct int) int16 {
	f := float64(pct) / 100.0
	return int16(math.Round(float64(VolMinRaw) + f*float64(VolMaxRaw-VolMinRaw)))
}

// --- Mic gain ---

func ReadMicGainPacket() []byte {
	p := newReport(TypeRead, CmdMicGain)
	p[3] = 0x02
	return p
}

func WriteMicGainPacket(gainDB int8) []byte {
	p := newReport(TypeWrite, CmdMicGain)
	p[3] = 0x02
	p[4] = 0x80
	p[5] = byte(gainDB)
	return p
}

func ParseMicGain(resp []byte) (int8, error) {
	if len(resp) < 6 || resp[0] != ReportID || resp[2] != CmdMicGain || resp[3] != 0x02 {
		return 0, fmt.Errorf("not a mic gain response")
	}
	return int8(resp[5]), nil
}

// --- Balance ---
// The device has no single signed balance register; each channel's
// attenuation is set independently. side: true = left, false = right.

func ReadBalancePacket(left bool) []byte {
	p := newReport(TypeRead, CmdBalance)
	p[3] = 0x04
	if left {
		p[4] = 0x01
	} else {
		p[4] = 0x00
	}
	return p
}

// WriteBalancePacket encodes a balance value in [-15, 15]. Negative
// values pull the mix left, positive pull right; 0 leaves both
// channels uncut.
func WriteBalancePacket(left bool, v int) []byte {
	p := newReport(TypeWrite, CmdBalance)
	p[3] = 0x04
	var mag byte
	if left {
		p[4] = 0x01
		if v < 0 {
			mag = byte(256 + v)
		}
	} else {
		p[4] = 0x00
		if v > 0 {
			mag = byte(256 - v)
		}
	}
	p[6] = mag
	return p
}

func ParseBalance(resp []byte, left bool) (int, error) {
	if len(resp) < 7 || resp[0] != ReportID || resp[2] != CmdBalance {
		return 0, fmt.Errorf("not a balance response")
	}
	mag := int(resp[6])
	if mag == 0 {
		return 0, nil
	}
	if left {
		return mag - 256, nil
	}
	return 256 - mag, nil
}

// --- Latch / flash ---

// LatchPacket pushes buffered volume/EQ changes live without writing
// flash. Send after any volume or PEQ write.
func LatchPacket() []byte {
	p := newReport(TypeWrite, CmdTempWrite)
	p[3] = 0x04
	p[4], p[5], p[6], p[7] = 0xFF, 0xFF, 0xFF, 0xFF
	return p
}

// FlashSavePacket persists the current buffer permanently. Debounce
// this in the caller (e.g. a few seconds after the last change) since
// flash has a finite write-cycle life.
func FlashSavePacket() []byte {
	p := newReport(TypeWrite, CmdFlashSave)
	p[3] = 0x01
	return p
}
