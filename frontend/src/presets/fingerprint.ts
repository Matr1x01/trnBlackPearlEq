/**
 * Deterministic fingerprints for EQ configurations.
 *
 * The DAC reports its ten PEQ bands but never says which preset they came
 * from -- it has no concept of our library. To show the user which saved
 * preset is live, we hash what the preset *is* (its EQ content) and match
 * on that instead of on an ID.
 *
 * The two sides of the comparison come from different places:
 *
 *     local preset  ──┐                       ┌── same string ──> same hash
 *                     ├─> normalize -> hash ──┤
 *     DAC read      ──┘                       └── different    ──> no match
 *
 * so normalisation has to erase every difference that is *not* a difference
 * in sound. See docs/pyblackpearl-findings.md §4 for where these rules come
 * from -- they are the reference implementation's comparison semantics,
 * expressed as a canonical form rather than as a tolerance loop.
 *
 *   - Property order is fixed by the canonical form, so object shape and key
 *     order on either side are irrelevant.
 *   - Values are quantised to the resolution the hardware actually stores:
 *     whole Hz (uint16), Q and gain in 1/256 dB steps. A local 999.6 Hz and
 *     a device-reported 1000 Hz are the same band.
 *   - Gains under 0.25 dB become exactly 0, matching the snap-to-zero that
 *     ParsePEQResponse already applies to kill float round-trip ghosts.
 *   - A band with no effective gain is *inert*: it makes no sound whatever
 *     its frequency, Q or type, and a disabled band is inert by definition.
 *     Those collapse to a single "off" token, so a preset does not fail to
 *     match because a switched-off band was parked at a different frequency.
 *
 * Deliberately excluded: preset id, name, target, pinned state and every
 * timestamp. None of them exist on the device, and two presets with the same
 * curve under different names must fingerprint identically.
 */

import type { EQBand, Preset } from "../api/client";

/** Hardware stores freq as whole Hz, Q and gain as fixed-point /256. */
const UNITS_PER_DB = 256;

/** Matches hidproto.ParsePEQResponse: below this a gain reads back as zero. */
const GAIN_EPSILON_DB = 0.25;

/** One band reduced to the values the hardware actually distinguishes. */
type CanonicalBand = string;

const INERT: CanonicalBand = "-";

function canonicalBand(band: EQBand): CanonicalBand {
  // A disabled band is written to the device with gain forced to 0 (see
  // hidproto.WritePEQPacket), so it must canonicalise the same way as a
  // band that is enabled but sitting at 0 dB.
  const rawGain = band.enabled ? band.gainDb : 0;
  const gain = Math.round(rawGain * UNITS_PER_DB) / UNITS_PER_DB;
  if (!Number.isFinite(gain) || Math.abs(gain) < GAIN_EPSILON_DB) return INERT;

  const type = String(band.type ?? "PK").toUpperCase();
  const freq = Math.round(band.freqHz);
  const q = Math.round(band.q * UNITS_PER_DB);
  const gainFixed = Math.round(gain * UNITS_PER_DB);

  return `${type}:${freq}:${q}:${gainFixed}`;
}

/**
 * The canonical text form of a band set. Exported for debugging and tests --
 * when two fingerprints unexpectedly differ, diffing these says why.
 */
export function canonicalizeBands(bands: EQBand[]): string {
  // Band order is positional: index i is hardware slot i, so the list is
  // never sorted. Two presets with the same bands in a different order are
  // genuinely different configurations.
  return bands.map(canonicalBand).join("|");
}

/**
 * 64-bit FNV-1a over the canonical form's UTF-16LE bytes, as 16 lowercase
 * hex digits. (Two bytes per code unit, so digests differ from FNV-1a run
 * over UTF-8 -- consistent with itself is all that matters here.)
 *
 * Chosen over SubtleCrypto deliberately: crypto.subtle is async and only
 * exists in secure contexts, and the README documents opening this UI from a
 * phone over plain http on the LAN, where it would be undefined. FNV-1a is a
 * few lines, synchronous (so it composes with useMemo), and stable across
 * engines and versions. It is not a cryptographic hash and does not need to
 * be -- nothing here is adversarial, and a library holds tens of presets.
 */
export function hashString(input: string): string {
  // The hash is carried as four 16-bit limbs, least significant first.
  // JS bitwise operators are 32-bit and would overflow on a 64-bit multiply;
  // 16-bit limbs keep every partial product under 2^32, where doubles are
  // still exact. BigInt would also work but is markedly slower per character.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2; // offset basis 0xcbf29ce484222325

  // FNV prime 0x100000001b3 == 2^40 + 0x1b3, i.e. limb0 = 0x1b3, limb2 = 0x100.
  const P0 = 0x01b3;
  const P2 = 0x0100;

  for (let i = 0; i < input.length; i++) {
    // Each UTF-16 code unit is fed as two bytes, little end first, so
    // characters outside Latin-1 cannot collide. The canonical form is ASCII
    // today, but that should not be load-bearing.
    const code = input.charCodeAt(i);
    for (let half = 0; half < 2; half++) {
      h0 ^= half === 0 ? code & 0xff : code >>> 8;

      // Multiply mod 2^64. Terms involving prime limbs 1 and 3 vanish (both
      // are zero), and anything shifted past limb 3 falls off the top.
      let r0 = h0 * P0;
      let r1 = h1 * P0;
      let r2 = h2 * P0 + h0 * P2;
      let r3 = h3 * P0 + h1 * P2;

      r1 += Math.floor(r0 / 0x10000);
      r2 += Math.floor(r1 / 0x10000);
      r3 += Math.floor(r2 / 0x10000);

      h0 = r0 & 0xffff;
      h1 = r1 & 0xffff;
      h2 = r2 & 0xffff;
      h3 = r3 & 0xffff;
    }
  }

  const hex = (v: number) => v.toString(16).padStart(4, "0");
  return hex(h3) + hex(h2) + hex(h1) + hex(h0);
}

/**
 * The fingerprint of a band set: identical EQ content always yields an
 * identical string, whichever side of the wire it arrived from.
 */
export function fingerprintBands(bands: EQBand[]): string {
  return hashString(canonicalizeBands(bands));
}

/** Convenience wrapper -- a preset fingerprints purely by its bands. */
export function fingerprintPreset(preset: Preset): string {
  return fingerprintBands(preset.bands);
}

/** True when a band set makes no audible change at all. */
export function isFlat(bands: EQBand[]): boolean {
  return bands.every((b) => canonicalBand(b) === INERT);
}

/**
 * Finds the saved preset whose EQ content matches what the DAC reports.
 *
 * Returns null rather than guessing. Three cases produce no match, and all
 * three must leave the selection alone rather than highlight the wrong card:
 *
 *   - nothing in the library has this curve (the user tuned by hand, or the
 *     DAC still holds someone else's flashed settings);
 *   - the device is flat, which every unused library also is -- "flat" is not
 *     evidence that any particular preset is loaded;
 *   - several presets share the curve, so the device state cannot tell them
 *     apart. `preferId` breaks that tie only when it is already one of the
 *     candidates, which keeps a user's existing selection stable instead of
 *     snapping it to whichever duplicate sorts first.
 */
export function matchPresetToDevice(
  presets: Preset[],
  deviceBands: EQBand[],
  preferId?: string | null,
): string | null {
  if (deviceBands.length === 0 || isFlat(deviceBands)) return null;

  const target = fingerprintBands(deviceBands);
  const matches = presets.filter((p) => fingerprintPreset(p) === target);

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].id;
  return matches.some((p) => p.id === preferId) ? preferId! : null;
}
