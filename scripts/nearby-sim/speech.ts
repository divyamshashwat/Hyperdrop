/**
 * Synthetic speech for Nearby calibration: no recordings needed, fully reproducible.
 *
 * What matters for a 2-8 kHz tone modem is where speech puts its energy, and when:
 *  - voiced vowels: harmonics of a gliding pitch, shaped by formants, falling ~6 dB/octave;
 *    most energy sits below 1 kHz, but F3-F5 still reach 2.5-4.5 kHz;
 *  - fricatives: "sh" is noise around 2.5-5 kHz (right on the carriers), "s" around 4-8 kHz;
 *  - plosive bursts: short broadband clicks; pauses between words.
 * A syllable rate of ~4 per second gives speech its on/off rhythm, which is what a
 * symbol-by-symbol detector actually has to survive.
 */

export type Rng = () => number;

export function rng(seed: number): Rng {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
}

export function gaussian(r: Rng) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

const between = (r: Rng, a: number, b: number) => a + (b - a) * r();

/** [F1, F2, F3] in Hz for a typical adult male voice; F4/F5 are added on top. */
const VOWELS: Array<[number, number, number]> = [
  [730, 1090, 2440], // a
  [270, 2290, 3010], // i
  [300, 870, 2240], // u
  [530, 1840, 2480], // e
  [570, 840, 2410], // o
  [660, 1720, 2410], // ae
  [490, 1350, 1690], // er
  [440, 1020, 2240], // uh
];

/** Two-pole resonator (constant peak gain), used to colour fricative noise. */
function bandpass(x: Float32Array, rate: number, centre: number, q: number) {
  const w = (2 * Math.PI * centre) / rate;
  const alpha = Math.sin(w) / (2 * q);
  const b0 = alpha, b2 = -alpha;
  const a0 = 1 + alpha, a1 = -2 * Math.cos(w), a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/** Raised-cosine fade in/out so segments don't click (clicks would be unfair broadband noise). */
function fade(x: Float32Array, rate: number, ms = 12) {
  const n = Math.min(Math.floor(x.length / 2), Math.round((rate * ms) / 1000));
  for (let i = 0; i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    x[i] *= g;
    x[x.length - 1 - i] *= g;
  }
}

function vowel(r: Rng, rate: number, n: number, voice: { f0: [number, number]; tract: number }): Float32Array {
  const out = new Float32Array(n);
  const [b1, b2, b3] = VOWELS[Math.floor(r() * VOWELS.length)];
  const formants = [b1, b2, b3, 3500, 4500].map((f) => f * voice.tract * between(r, 0.94, 1.06));
  const widths = [80, 100, 140, 220, 300];
  const gains = [1, 0.7, 0.35, 0.18, 0.1];
  const f0a = between(r, ...voice.f0);
  const f0b = f0a * between(r, 0.8, 1.2); // intonation glide
  const harmonics = Math.floor(7800 / Math.min(f0a, f0b));
  const phase = new Float64Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) phase[k] = r() * 2 * Math.PI;
  for (let i = 0; i < n; i++) {
    const f0 = f0a + ((f0b - f0a) * i) / n;
    let s = 0;
    for (let k = 1; k <= harmonics; k++) {
      const f = k * f0;
      if (f > 7800) break;
      let env = 0;
      for (let j = 0; j < 5; j++) {
        const d = (f - formants[j]) / widths[j];
        env += gains[j] / (1 + d * d);
      }
      phase[k] += (2 * Math.PI * f) / rate;
      s += (env * Math.sin(phase[k])) / Math.sqrt(k); // ~-3 dB/oct source on top of the formant roll-off
    }
    out[i] = s;
  }
  return out;
}

function fricative(r: Rng, rate: number, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = gaussian(r);
  const kind = r();
  if (kind < 0.4) {
    bandpass(out, rate, between(r, 5200, 7000), 1.4); // s
    bandpass(out, rate, between(r, 5200, 7000), 1.4);
  } else if (kind < 0.8) {
    bandpass(out, rate, between(r, 2800, 3800), 1.1); // sh: squarely on the carriers
    bandpass(out, rate, between(r, 2800, 3800), 1.1);
  } else {
    bandpass(out, rate, 4000, 0.4); // f / th: weak and broad
    for (let i = 0; i < n; i++) out[i] *= 0.4;
  }
  return out;
}

function plosive(r: Rng, rate: number, n: number): Float32Array {
  const out = new Float32Array(n);
  const tau = rate * 0.004;
  for (let i = 0; i < n; i++) out[i] = gaussian(r) * Math.exp(-i / tau);
  bandpass(out, rate, between(r, 1500, 4000), 0.6);
  return out;
}

const rms = (x: Float32Array) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
};

/** One talker, normalised to RMS 1 over the whole clip (pauses included, as a listener hears it). */
export function talker(seconds: number, rate: number, seed: number): Float32Array {
  const r = rng(seed);
  const female = r() < 0.5;
  const voice = female ? { f0: [170, 260] as [number, number], tract: 1.15 } : { f0: [90, 150] as [number, number], tract: 1 };
  const out = new Float32Array(Math.round(seconds * rate));
  let at = 0;
  const ms = (a: number, b: number) => Math.round((between(r, a, b) * rate) / 1000);
  while (at < out.length) {
    const t = r();
    let seg: Float32Array;
    let level = between(r, 0.6, 1);
    if (t < 0.55) seg = vowel(r, rate, ms(90, 260), voice);
    else if (t < 0.75) {
      seg = fricative(r, rate, ms(70, 180));
      level *= 0.35; // fricatives carry far less energy than vowels...
    } else if (t < 0.8) {
      seg = plosive(r, rate, ms(15, 30));
      level *= 0.6;
    } else {
      at += ms(40, 300); // ...and words have gaps
      continue;
    }
    const k = level / Math.max(rms(seg), 1e-9);
    fade(seg, rate);
    for (let i = 0; i < seg.length && at + i < out.length; i++) out[at + i] += seg[i] * k;
    at += seg.length;
  }
  const g = 1 / Math.max(rms(out), 1e-9);
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

/** Café babble: several talkers at once, normalised to RMS 1. */
export function babble(seconds: number, rate: number, seed: number, talkers = 6): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let t = 0; t < talkers; t++) {
    const x = talker(seconds, rate, seed * 101 + t * 7919);
    for (let i = 0; i < out.length; i++) out[i] += x[i];
  }
  const g = 1 / Math.max(rms(out), 1e-9);
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

/** Fraction of a clip's energy inside [lo, hi] Hz, via a coarse DFT on frames (for sanity reporting). */
export function bandShare(x: Float32Array, rate: number, lo: number, hi: number): number {
  const N = 1024;
  let inBand = 0;
  let total = 0;
  for (let start = 0; start + N <= x.length; start += N * 8) {
    for (let k = 1; k < N / 2; k++) {
      let re = 0;
      let im = 0;
      const w = (2 * Math.PI * k) / N;
      for (let i = 0; i < N; i++) {
        const v = x[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
        re += v * Math.cos(w * i);
        im -= v * Math.sin(w * i);
      }
      const p = re * re + im * im;
      const f = (k * rate) / N;
      total += p;
      if (f >= lo && f <= hi) inBand += p;
    }
  }
  return inBand / Math.max(total, 1e-20);
}

export { rms };
