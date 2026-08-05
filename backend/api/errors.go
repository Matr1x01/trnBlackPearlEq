package api

import "errors"

var (
	errUnknownRegister = errors.New("unknown register")
	errUnknownValue    = errors.New("unknown value for this register")
	errUnknownBand     = errors.New("eq band index must be 0-9")
	errInvalidRange    = errors.New("value out of range")

	errNoPresetStore       = errors.New("preset library unavailable: could not open the presets file")
	errUnknownPresetAction = errors.New("unknown preset action")
)
