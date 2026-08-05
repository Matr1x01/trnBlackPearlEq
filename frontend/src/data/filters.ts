import type { FilterMode } from "../api/client";

/**
 * The five DAC reconstruction filters the hardware exposes.
 *
 * `phase` and `rolloff` drive the impulse-response drawing in
 * <FilterCurve>. The two axes are what actually distinguish these filters:
 *
 * - roll-off  — how sharply the filter cuts at Nyquist. A sharp ("fast")
 *   cut needs a longer filter, which rings for more cycles; a gentle
 *   ("slow") cut rings less but lets more image energy through.
 * - phase     — linear phase spreads ringing symmetrically around the
 *   transient (pre- *and* post-ringing) but preserves phase relationships.
 *   Minimum phase puts all of it after the transient (no pre-ringing) at
 *   the cost of phase shift, and settles sooner -- hence "low latency".
 *
 * NOS bypasses interpolation entirely: the impulse is a single held
 * sample, so there is no ringing at all.
 */
export interface FilterSpec {
  value: FilterMode;
  /** Short label for compact toggles. */
  short: string;
  /** Full name as the vendor labels it. */
  title: string;
  subtitle: string;
  description: string;
  phase: "linear" | "minimum" | "none";
  rolloff: "fast" | "slow" | "none";
}

export const FILTERS: FilterSpec[] = [
  {
    value: "fast-ll",
    short: "F-LL",
    title: "FAST-LL",
    subtitle: "Low-latency filter",
    description:
      "The voice is thick and powerful, warm and comfortable, suitable for both vocals and slow-paced music.",
    phase: "minimum",
    rolloff: "fast",
  },
  {
    value: "fast-pc",
    short: "F-PC",
    title: "FAST-PC",
    subtitle: "Phase compensation filter",
    description:
      "It restores natural sounds and is suitable for music with a tight rhythm and passionate surges.",
    phase: "linear",
    rolloff: "fast",
  },
  {
    value: "slow-ll",
    short: "S-LL",
    title: "SLOW-LL",
    subtitle: "Slow low-latency filter",
    description:
      "It enhances the sound field and detail performance, making it suitable for scenarios such as symphonies.",
    phase: "minimum",
    rolloff: "slow",
  },
  {
    value: "slow-pc",
    short: "S-PC",
    title: "SLOW-PC",
    subtitle: "Slow phase compensation filter",
    description:
      "The sound is clear and natural, with high fidelity and a prominent monitoring style.",
    phase: "linear",
    rolloff: "slow",
  },
  {
    value: "nos",
    short: "NOS",
    title: "NON OS",
    subtitle: "Non-oversampling filter",
    description:
      "The sampling rate matches the signal frequency to preserve the original characteristics of the signal.",
    phase: "none",
    rolloff: "none",
  },
];

export function filterSpec(value: FilterMode | null): FilterSpec | null {
  return FILTERS.find((f) => f.value === value) ?? null;
}

export const AMP_MODES = [
  {
    value: "class-h",
    label: "Class-H",
    description:
      "Rail voltage tracks the signal, so the amplifier only draws the headroom it needs. Cooler and easier on battery.",
  },
  {
    value: "class-ab",
    label: "Class-AB",
    description:
      "Fixed rail voltage for a constant operating point. Runs warmer and draws more current, but the most linear of the two.",
  },
] as const;

export const GAIN_MODES = [
  {
    value: "low",
    label: "Low",
    description: "Lower output swing and noise floor. Best for sensitive IEMs.",
  },
  {
    value: "high",
    label: "High",
    description: "Extra voltage swing to drive higher-impedance or less sensitive headphones.",
  },
] as const;
