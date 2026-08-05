/**
 * JavaScript mirror of the Go RBJ biquad math in hidproto/biquad.go.
 * Used purely for drawing the EQ response curve in the browser —
 * no audio processing happens here.
 */

import type { EQBand } from "../api/client";

const SAMPLE_RATE = 48000;

interface Coeffs {
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
}

function calcCoeffs(band: EQBand): Coeffs {
  let freq = band.freqHz > 0 ? band.freqHz : 1;
  let q    = band.q > 0 ? band.q : 0.01;
  const g  = band.enabled ? band.gainDb : 0;

  const A     = Math.pow(10, g / 40);
  const w0    = (2 * Math.PI * freq) / SAMPLE_RATE;
  const sn    = Math.sin(w0);
  const cs    = Math.cos(w0);
  const alpha = sn / (2 * q);

  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;

  switch (band.type) {
    case "PK": {
      b0 = 1 + alpha * A;   b1 = -2 * cs; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;   a1 = -2 * cs; a2 = 1 - alpha / A;
      break;
    }
    case "LS":
    case "HS": {
      const sqA = Math.sqrt(A);
      const s   = band.type === "HS" ? 1 : -1;
      b0 = A * ((A + 1) + s * (A - 1) * cs + 2 * sqA * alpha);
      b1 = -s * 2 * A * ((A - 1) + s * (A + 1) * cs);
      b2 = A * ((A + 1) + s * (A - 1) * cs - 2 * sqA * alpha);
      a0 = (A + 1) - s * (A - 1) * cs + 2 * sqA * alpha;
      a1 = s * 2 * ((A - 1) - s * (A + 1) * cs);
      a2 = (A + 1) - s * (A - 1) * cs - 2 * sqA * alpha;
      break;
    }
    default:
      return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  }

  return { b0: b0/a0, b1: b1/a0, b2: b2/a0, a1: a1/a0, a2: a2/a0 };
}

function responseDB(c: Coeffs, freqHz: number): number {
  const w    = (2 * Math.PI * freqHz) / SAMPLE_RATE;
  const cosW = Math.cos(w);  const sinW = Math.sin(w);
  const cos2W = Math.cos(2 * w); const sin2W = Math.sin(2 * w);

  const numRe = c.b0 + c.b1 * cosW + c.b2 * cos2W;
  const numIm = -c.b1 * sinW - c.b2 * sin2W;
  const denRe = 1   + c.a1 * cosW + c.a2 * cos2W;
  const denIm = -c.a1 * sinW - c.a2 * sin2W;

  const denom = denRe * denRe + denIm * denIm;
  if (denom === 0) return 0;
  const mag2 = (numRe * numRe + numIm * numIm) / denom;
  if (mag2 <= 0) return 0;
  return 10 * Math.log10(mag2);
}

/** Combined dB response of all bands at freqHz (sum in log domain). */
export function combinedResponseDb(bands: EQBand[], freqHz: number): number {
  return bands.reduce((sum, b) => sum + responseDB(calcCoeffs(b), freqHz), 0);
}
