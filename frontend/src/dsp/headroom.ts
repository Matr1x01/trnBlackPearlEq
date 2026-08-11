/**
 * Digital headroom analysis for the current EQ settings.
 *
 * Any band that boosts pushes the signal above unity at that frequency.
 * Feed a track that already peaks near 0 dBFS through a filter with a
 * +6 dB peak and the EQ stage has to represent a +6 dBFS sample -- which
 * it cannot, so it clips. This is the same "preamp" problem every
 * parametric EQ has (Equalizer APO, AutoEQ and friends all report it as
 * a recommended preamp cut), and the fix is the same: attenuate first,
 * or lower the offending bands.
 *
 * Where the master volume fits, and why that changed:
 *
 * - This used to report the EQ peak alone and refuse to sum the master in,
 *   because the HID protocol does not say whether the volume register is
 *   digital gain, analogue makeup gain, or where it sits relative to the
 *   EQ stage.
 * - The reference implementation answers it: it treats VolMaxRaw as the
 *   largest gain the output stage can represent, shared between volume and
 *   EQ boost, and flags clipping when
 *   `volume_raw > VolMaxRaw - peak_eq_boost * UnitsPerDB`. See
 *   docs/pyblackpearl-findings.md §1.
 * - Rearranged, that is simply: the boost still available at the current
 *   volume is `ceilingDb = VOL_MAX_DB - volumeDb`, and the EQ clips when
 *   its peak exceeds it. That is the model used here.
 * - This is inferred from a working implementation rather than from vendor
 *   documentation, but it degrades safely in both directions: a flat EQ
 *   never clips at any volume, and at low volume a large boost is correctly
 *   reported as harmless.
 * - Worst case input is still assumed: a full-scale signal at exactly the
 *   frequency where the EQ peaks. Real music rarely does that, so this errs
 *   toward warning early.
 */

import type { EQBand } from "../api/client";
import { combinedResponseDb } from "./biquad";

/** Mirrors hidproto.VolMinRaw / VolMaxRaw / UnitsPerDB. */
const VOL_MIN_RAW = -9472;
const VOL_MAX_RAW = 6440;
const UNITS_PER_DB = 256;

/**
 * The most gain the output stage can represent, in dB (+25.16). Volume and
 * EQ boost both draw on it, so it is the ceiling the two are summed against.
 */
export const VOL_MAX_DB = VOL_MAX_RAW / UNITS_PER_DB;

/** Volume slider percent -> dB, matching the Go conversion. */
export function volumePercentToDb(percent: number): number {
  const raw = VOL_MIN_RAW + (percent / 100) * (VOL_MAX_RAW - VOL_MIN_RAW);
  return raw / UNITS_PER_DB;
}

/**
 * EQ boost still available before the output stage saturates, in dB.
 * Falls to 0 at full volume: there, any boost at all overshoots.
 */
export function ceilingDbAt(volumePercent: number): number {
  return Math.max(0, VOL_MAX_DB - volumePercentToDb(volumePercent));
}

export type HeadroomStatus = "safe" | "caution" | "clipping";

export interface HeadroomResult {
  /** Highest boost the EQ curve reaches, in dB. Never below 0. */
  peakGainDb: number;
  /** Frequency at which that peak occurs. */
  peakFreqHz: number;
  /** Master volume expressed in dB (negative below unity). */
  volumeDb: number;
  /** Boost the device can still accept at this volume, in dB. */
  ceilingDb: number;
  /**
   * dB of boost left before EQ + volume exceeds the device maximum.
   * Negative means a full-scale signal at peakFreqHz overshoots.
   */
  headroomDb: number;
  status: HeadroomStatus;
}

const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const STEPS = 256;

/** Boost below this is rounding noise, not a real lift. */
const NEGLIGIBLE_DB = 0.5;
/** Headroom under this much is close enough to warn about. */
const CAUTION_DB = 3;

/**
 * Highest boost the EQ curve applies, and where. Volume plays no part --
 * this is the property of the curve alone that drives the recommended
 * preamp cut shown on preset cards.
 */
export function peakBoost(bands: EQBand[]): { peakGainDb: number; peakFreqHz: number } {
  // Log-spaced sweep: dense enough that a high-Q peak isn't stepped over.
  let peakGainDb = 0;
  let peakFreqHz = FREQ_MIN;
  const ratio = FREQ_MAX / FREQ_MIN;
  for (let i = 0; i <= STEPS; i++) {
    const f = FREQ_MIN * Math.pow(ratio, i / STEPS);
    const db = combinedResponseDb(bands, f);
    if (db > peakGainDb) {
      peakGainDb = db;
      peakFreqHz = f;
    }
  }
  return { peakGainDb, peakFreqHz };
}

export function analyzeHeadroom(bands: EQBand[], volumePercent: number): HeadroomResult {
  const { peakGainDb, peakFreqHz } = peakBoost(bands);

  const volumeDb = volumePercentToDb(volumePercent);
  const ceilingDb = ceilingDbAt(volumePercent);
  const headroomDb = ceilingDb - peakGainDb;

  let status: HeadroomStatus;
  if (peakGainDb <= NEGLIGIBLE_DB) {
    // Nothing for the master to amplify into an overshoot, whatever the
    // volume: a flat curve passes through at unity.
    status = "safe";
  } else if (headroomDb <= 0) {
    status = "clipping";
  } else if (headroomDb <= CAUTION_DB) {
    status = "caution";
  } else {
    status = "safe";
  }

  return {
    peakGainDb,
    peakFreqHz,
    volumeDb,
    ceilingDb,
    headroomDb,
    status,
  };
}

export function formatHz(hz: number): string {
  if (hz >= 10000) return `${(hz / 1000).toFixed(1)} kHz`;
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  return `${Math.round(hz)} Hz`;
}
