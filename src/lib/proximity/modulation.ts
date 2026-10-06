import { TONES } from "./protocol";

/**
 * Frequency profiles, from hardware calibration (docs/NEARBY.md section 4).
 *
 * First measured row, iPhone (iOS 18.5, Safari, 48 kHz) next to a Windows PC speaker:
 *   20.0 ✓  20.5 ✓ (strongest)  21.0 ✓  21.5 ✕  22.0 ✕
 * The original 48 kHz profile (20.5-22.0 kHz) put half its carriers above that
 * cut-off and could never decode, so it was removed. One profile now sits inside
 * the measured passband and also fits 44.1 kHz hardware. Re-measure on more phones
 * before widening it.
 */
export interface FrequencyProfile {
  id: "ultrasonic-low";
  /** Four tones, low to high. Symbol n is sent as tones[n]. */
  tones: readonly [number, number, number, number];
  /** Both ends need at least this sample rate for the top tone to be representable. */
  minSampleRate: number;
}

export const PROFILES: readonly FrequencyProfile[] = [
  // 300 Hz spacing (2.25 detector bins at 48 kHz), all inside the measured 20.0-21.0 kHz passband.
  { id: "ultrasonic-low", tones: [20150, 20450, 20750, 21050], minSampleRate: 44000 },
];

export const SYMBOL_MS = 30;
export const RAMP_MS = 4;
/** Silence between repeated packets. */
export const GAP_MS = 220;
/** Conservative default output level (linear, 0..1). Lowest reliable level must come from testing. */
export const DEFAULT_AMPLITUDE = 0.22;

/** The profile a transmitter should use, from the sample rate its audio output actually runs at. */
export function chooseOutputProfile(sampleRate: number): FrequencyProfile | null {
  return PROFILES.find((p) => sampleRate >= p.minSampleRate && p.tones[TONES - 1] < (sampleRate / 2) * 0.97) ?? null;
}

/** Profiles a receiver can actually hear at its real capture rate (top tone well under Nyquist). */
export function profilesForCapture(sampleRate: number): FrequencyProfile[] {
  return PROFILES.filter((p) => p.tones[TONES - 1] < (sampleRate / 2) * 0.97);
}

export function symbolSamples(sampleRate: number): number {
  return Math.round((sampleRate * SYMBOL_MS) / 1000);
}

/**
 * Render symbols to PCM: one clean sine per symbol (never square or saw waves,
 * whose harmonics fold into audible range), each with a raised-cosine fade in
 * and out so there are no clicks or broadband transients.
 */
export function renderSymbols(
  symbols: number[],
  profile: FrequencyProfile,
  sampleRate: number,
  amplitude = DEFAULT_AMPLITUDE,
  trailingGapMs = 0,
): Float32Array {
  const n = symbolSamples(sampleRate);
  const ramp = Math.max(1, Math.round((sampleRate * RAMP_MS) / 1000));
  const gap = Math.round((sampleRate * trailingGapMs) / 1000);
  const out = new Float32Array(symbols.length * n + gap);
  for (let s = 0; s < symbols.length; s++) {
    const w = (2 * Math.PI * profile.tones[symbols[s]]) / sampleRate;
    const base = s * n;
    for (let i = 0; i < n; i++) {
      let env = 1;
      if (i < ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp);
      else if (i >= n - ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / ramp);
      out[base + i] = amplitude * env * Math.sin(w * i);
    }
  }
  return out;
}

/** A steady calibration tone with smooth edges. */
export function renderTone(freq: number, sampleRate: number, seconds: number, amplitude = DEFAULT_AMPLITUDE): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const ramp = Math.round(sampleRate * 0.03);
  const w = (2 * Math.PI * freq) / sampleRate;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = i < ramp ? i / ramp : i > n - ramp ? (n - i) / ramp : 1;
    out[i] = amplitude * env * Math.sin(w * i);
  }
  return out;
}
