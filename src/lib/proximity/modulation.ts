import { TONES } from "./protocol";

/**
 * Frequency profile (docs/NEARBY.md section 4).
 *
 * Near-ultrasonic carriers (20-21 kHz) were tried first and did not pair in
 * practice: laptop speakers and phone capture paths roll off too steeply up
 * there. Nearby now uses an audible band that every speaker and microphone
 * reproduces well, so the receiver plays a short, quiet chirp.
 *
 * Carriers sit in 2.4-4.2 kHz: above most speech and hum energy, below where
 * small speakers start to fall off, and with no carrier at a harmonic of
 * another (speaker distortion can't fake a symbol). 600 Hz spacing is many
 * detector bins wide, so reverb and frequency error stay well separated.
 */
export interface FrequencyProfile {
  id: "audible";
  /** Four tones, low to high. Symbol n is sent as tones[n]. */
  tones: readonly [number, number, number, number];
  /** Both ends need at least this sample rate for the top tone to be representable. */
  minSampleRate: number;
}

export const PROFILES: readonly FrequencyProfile[] = [{ id: "audible", tones: [2400, 3000, 3600, 4200], minSampleRate: 16000 }];

/** Long enough that room echo of the previous symbol has mostly died down before the detector trusts the next. */
export const SYMBOL_MS = 50;
export const RAMP_MS = 6;
/** Silence between repeated packets. */
export const GAP_MS = 300;
/** Conservative default output level (linear, 0..1). Audible, so keep it modest. */
export const DEFAULT_AMPLITUDE = 0.18;

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
 * whose harmonics would land on other carriers), each with a raised-cosine fade in
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
