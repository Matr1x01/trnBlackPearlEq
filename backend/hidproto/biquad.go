package hidproto

import "math"

// Band is one parametric EQ band as configured by the user, in
// human-readable units. The device itself only ever sees the derived
// biquad coefficients plus these values for display/identification.
type Band struct {
	Type    FilterType
	FreqHz  float64
	Q       float64
	GainDB  float64
	Enabled bool
}

// Coeffs holds a normalized (a0 == 1) biquad, matching what the RBJ
// Audio EQ Cookbook produces and what the device's DSP expects,
// transmitted as five little-endian float32 values: b0, b1, b2, a1, a2.
type Coeffs struct {
	B0, B1, B2, A1, A2 float64
}

const sampleRateHz = 48000.0

// CalcCoeffs derives RBJ biquad coefficients for a band. Disabled
// bands should be passed with GainDB == 0 by the caller (a disabled
// band is transmitted as a flat, inert filter rather than omitted).
func CalcCoeffs(b Band) Coeffs {
	freq := b.FreqHz
	if freq <= 0 {
		freq = 1
	}
	q := b.Q
	if q <= 0 {
		q = 0.01
	}
	g := b.GainDB

	A := math.Pow(10, g/40)
	w0 := 2 * math.Pi * freq / sampleRateHz
	sn, cs := math.Sin(w0), math.Cos(w0)
	alpha := sn / (2 * q)

	var b0, b1, b2, a0, a1, a2 float64

	switch b.Type {
	case FilterPeaking:
		b0, b1, b2 = 1+alpha*A, -2*cs, 1-alpha*A
		a0, a1, a2 = 1+alpha/A, -2*cs, 1-alpha/A
	case FilterLowShelf, FilterHighShelf:
		sqA := math.Sqrt(A)
		s := -1.0
		if b.Type == FilterHighShelf {
			s = 1.0
		}
		b0 = A * ((A + 1) + s*(A-1)*cs + 2*sqA*alpha)
		b1 = -s * 2 * A * ((A - 1) + s*(A+1)*cs)
		b2 = A * ((A + 1) + s*(A-1)*cs - 2*sqA*alpha)
		a0 = (A + 1) - s*(A-1)*cs + 2*sqA*alpha
		a1 = s * 2 * ((A - 1) - s*(A+1)*cs)
		a2 = (A + 1) - s*(A-1)*cs - 2*sqA*alpha
	default:
		b0, b1, b2, a0, a1, a2 = 1, 0, 0, 1, 0, 0
	}

	return Coeffs{B0: b0 / a0, B1: b1 / a0, B2: b2 / a0, A1: a1 / a0, A2: a2 / a0}
}

// ResponseDB returns the filter's magnitude response in dB at freqHz,
// used for drawing the EQ graph in the UI.
func ResponseDB(c Coeffs, freqHz float64) float64 {
	w := 2 * math.Pi * freqHz / sampleRateHz
	cosW, sinW := math.Cos(w), math.Sin(w)
	cos2W, sin2W := math.Cos(2*w), math.Sin(2*w)

	numRe := c.B0 + c.B1*cosW + c.B2*cos2W
	numIm := -c.B1*sinW - c.B2*sin2W
	denRe := 1 + c.A1*cosW + c.A2*cos2W
	denIm := -c.A1*sinW - c.A2*sin2W

	denomSq := denRe*denRe + denIm*denIm
	if denomSq == 0 {
		return 0
	}
	mag2 := (numRe*numRe + numIm*numIm) / denomSq
	if mag2 <= 0 {
		return 0
	}
	return 10 * math.Log10(mag2)
}
