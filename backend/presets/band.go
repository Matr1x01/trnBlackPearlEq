package presets

import (
	"fmt"
	"math"
	"strings"
)

// Limits applied to imported/edited bands before they are stored, so a
// hand-written or third-party preset file can never push nonsense into
// the biquad math. These are deliberately wider than the UI controls.
const (
	MinFreqHz = 20.0
	MaxFreqHz = 20000.0
	MinQ      = 0.05
	MaxQ      = 20.0
	MinGainDB = -30.0
	MaxGainDB = 30.0

	defaultQ = 0.71
)

// NormalizeBands validates a band list and returns a clamped copy. It
// requires exactly BandCount bands; the frontend and the apply path
// both depend on the index of a band matching its hardware slot.
func NormalizeBands(bands []Band) ([]Band, error) {
	if len(bands) != BandCount {
		return nil, ErrBandCount
	}
	out := make([]Band, BandCount)
	for i, b := range bands {
		t, err := normalizeType(b.Type)
		if err != nil {
			return nil, fmt.Errorf("band %d: %w", i, err)
		}
		if math.IsNaN(b.FreqHz) || math.IsNaN(b.Q) || math.IsNaN(b.GainDB) {
			return nil, fmt.Errorf("band %d: values must be numbers", i)
		}
		q := b.Q
		if q <= 0 {
			q = defaultQ
		}
		out[i] = Band{
			Type:    t,
			FreqHz:  clamp(b.FreqHz, MinFreqHz, MaxFreqHz),
			Q:       clamp(q, MinQ, MaxQ),
			GainDB:  clamp(b.GainDB, MinGainDB, MaxGainDB),
			Enabled: b.Enabled,
		}
	}
	return out, nil
}

func normalizeType(t string) (string, error) {
	switch strings.ToUpper(strings.TrimSpace(t)) {
	case "", "PK":
		return "PK", nil
	case "LS":
		return "LS", nil
	case "HS":
		return "HS", nil
	default:
		return "", fmt.Errorf("unknown filter type %q (want PK, LS or HS)", t)
	}
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
