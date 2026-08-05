package hidproto

import (
	"encoding/binary"
	"fmt"
	"math"
)

// ReadPEQPacket requests the current state of PEQ band idx (0-9).
func ReadPEQPacket(idx byte) []byte {
	p := newReport(TypeRead, CmdPEQValues)
	p[3], p[4], p[5] = 0x00, 0x00, idx
	p[6] = TypeEnd
	return p
}

// WritePEQPacket builds the full PEQ write packet for one band:
// header, five float32LE biquad coefficients, then freq/Q/gain/type
// metadata the device uses for its own bookkeeping (and which comes
// back verbatim on read).
//
// activeSlot should be whatever slot value the device last reported
// (see ParsePEQResponse) -- write it back unchanged unless you are
// deliberately switching slots.
func WritePEQPacket(idx byte, band Band, activeSlot byte) ([]byte, error) {
	ft := band.Type
	gain := band.GainDB
	if !band.Enabled {
		gain = 0
	}
	c := CalcCoeffs(Band{Type: ft, FreqHz: band.FreqHz, Q: band.Q, GainDB: gain})

	p := newReport(TypeWrite, CmdPEQValues)
	p[3] = 0x18 // payload length
	p[4] = 0x00
	p[5] = idx
	p[6] = 0x00
	p[7] = 0x00

	off := 8
	for _, f := range []float64{c.B0, c.B1, c.B2, c.A1, c.A2} {
		binary.LittleEndian.PutUint32(p[off:off+4], math.Float32bits(float32(f)))
		off += 4
	}

	freq := clampU16(band.FreqHz, 20, 20000)
	binary.LittleEndian.PutUint16(p[off:off+2], freq)
	off += 2

	qFixed := uint16(math.Round(band.Q * 256))
	binary.LittleEndian.PutUint16(p[off:off+2], qFixed)
	off += 2

	gainFixed := int16(math.Round(gain * 256))
	binary.LittleEndian.PutUint16(p[off:off+2], uint16(gainFixed))
	off += 2

	p[off] = byte(ft)
	off++
	p[off] = 0x00
	off++
	p[off] = activeSlot
	off++
	p[off] = TypeEnd

	return p, nil
}

func clampU16(v float64, lo, hi float64) uint16 {
	if v < lo {
		v = lo
	}
	if v > hi {
		v = hi
	}
	return uint16(math.Round(v))
}

// PEQReadResult is the decoded state of one band as reported by the
// hardware, plus the device's currently active preset slot.
type PEQReadResult struct {
	Index      byte
	Band       Band
	ActiveSlot byte
}

// ParsePEQResponse decodes a CmdPEQValues READ response. The device
// echoes freq/Q/gain/type at fixed offsets regardless of coefficient
// values, so we read those directly rather than re-deriving them from
// the biquad coefficients.
func ParsePEQResponse(resp []byte) (PEQReadResult, error) {
	if len(resp) < 37 || resp[0] != ReportID || resp[2] != CmdPEQValues {
		return PEQReadResult{}, fmt.Errorf("not a PEQ response")
	}
	idx := resp[5]
	freq := binary.LittleEndian.Uint16(resp[28:30])
	qRaw := binary.LittleEndian.Uint16(resp[30:32])
	gainRaw := int16(binary.LittleEndian.Uint16(resp[32:34]))
	ft := FilterType(resp[34])
	activeSlot := resp[36]

	gain := float64(gainRaw) / 256.0
	// Ignore sub-threshold ghost gains from float rounding, matching
	// the reference implementation's snap-to-zero behavior.
	if math.Abs(gain) < 0.25 {
		gain = 0
	}

	return PEQReadResult{
		Index: idx,
		Band: Band{
			Type:    ft,
			FreqHz:  float64(freq),
			Q:       float64(qRaw) / 256.0,
			GainDB:  gain,
			Enabled: gain != 0,
		},
		ActiveSlot: activeSlot,
	}, nil
}
