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
 * Scope, and why:
 *
 * - The verdict is driven by the EQ curve alone, because that part is
 *   unambiguous: a +6 dB peak needs 6 dB of cut, full stop.
 * - Master volume is reported alongside but deliberately NOT summed into
 *   the headroom figure. This device's volume spans about -37 dB to
 *   +25 dB (unity near 60%), and the HID protocol does not tell us
 *   whether that gain is digital, analogue makeup gain, or a mix -- nor
 *   whether it lands before or after the EQ stage. Summing +25 dB of it
 *   into a *digital* clipping number would assert a signal chain we
 *   cannot verify, and would flag a flat EQ at full volume as "clipping".
 * - What we can say is that boost stacked on boost is worse than either
 *   alone, so a positive master gain escalates an already-boosting EQ by
 *   one severity step.
 * - Worst case input is assumed: a full-scale signal at exactly the
 *   frequency where the EQ peaks. Real music rarely does that, so this
 *   errs toward warning early.
 */

import type { EQBand } from "../api/client";
import { combinedResponseDb } from "./biquad";

/** Mirrors hidproto.VolMinRaw / VolMaxRaw / UnitsPerDB. */
const VOL_MIN_RAW = -9472;
const VOL_MAX_RAW = 6440;
const UNITS_PER_DB = 256;

/** Volume slider percent -> dB, matching the Go conversion. */
export function volumePercentToDb(percent: number): number {
  const raw = VOL_MIN_RAW + (percent / 100) * (VOL_MAX_RAW - VOL_MIN_RAW);
  return raw / UNITS_PER_DB;
}

export type HeadroomStatus = "safe" | "caution" | "clipping";

export interface HeadroomResult {
  /** Highest boost the EQ curve reaches, in dB. Never below 0. */
  peakGainDb: number;
  /** Frequency at which that peak occurs. */
  peakFreqHz: number;
  /** Master volume expressed in dB (negative below unity). */
  volumeDb: number;
  /** True when the master is adding gain on top of the EQ. */
  masterBoosting: boolean;
  /** dB remaining before 0 dBFS. Negative means a full-scale signal clips. */
  headroomDb: number;
  status: HeadroomStatus;
}

const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const STEPS = 256;

/** Boost below this is rounding noise, not a real lift. */
const NEGLIGIBLE_DB = 0.5;
/** Above this much boost, a hot track will clip audibly. */
const SEVERE_DB = 3;

export function analyzeHeadroom(bands: EQBand[], volumePercent: number): HeadroomResult {
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

  const volumeDb = volumePercentToDb(volumePercent);
  const masterBoosting = volumeDb > 0;

  let status: HeadroomStatus;
  if (peakGainDb <= NEGLIGIBLE_DB) status = "safe";
  else if (peakGainDb <= SEVERE_DB) status = "caution";
  else status = "clipping";

  // Boost on top of boost: escalate one step, but never from safe (a flat
  // EQ has nothing for the master to amplify into clipping).
  if (masterBoosting && status === "caution") status = "clipping";

  return {
    peakGainDb,
    peakFreqHz,
    volumeDb,
    masterBoosting,
    headroomDb: -peakGainDb,
    status,
  };
}

export function formatHz(hz: number): string {
  if (hz >= 10000) return `${(hz / 1000).toFixed(1)} kHz`;
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  return `${Math.round(hz)} Hz`;
}
