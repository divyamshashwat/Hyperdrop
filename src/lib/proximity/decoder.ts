import type { FrequencyProfile } from "./modulation";
import { symbolSamples } from "./modulation";
import { DATA_SYMBOLS, PREAMBLE, SYNC, TONES, decodeDataSymbols, type DecodedPacket } from "./protocol";

/**
 * Streaming MFSK decoder.
 *
 *   samples -> hop-sized Goertzel energies at each carrier (+/- a tolerance window)
 *           -> preamble search (8 symbols, strict) -> timing lock
 *           -> sync check -> 49 data symbols -> Hamming -> CRC
 *
 * It only reports a packet when preamble, sync and CRC all agree. It never
 * guesses, and it does no full-spectrum FFT: just a few targeted detectors.
 */

const HOPS_PER_SYMBOL = 4;
/** Probe offsets (Hz) around each carrier so slight frequency error still lands. */
const PROBE_OFFSETS = [-70, 0, 70];
/** Preamble gate: winning tone must beat the others by ~5 dB and the noise floor by ~8 dB. */
const PREAMBLE_CONTRAST = 3.2;
const PREAMBLE_OVER_NOISE = 6;

export type DecoderEvent =
  | { type: "signal"; confidence: number }
  | { type: "preamble" }
  | { type: "sync-failed" }
  | { type: "crc-failed" }
  | { type: "packet"; packet: DecodedPacket; profile: FrequencyProfile["id"] };

export interface DecoderStats {
  profile: FrequencyProfile["id"];
  /** Per-carrier level over the last symbol window, dBFS-ish. */
  toneDb: number[];
  noiseDb: number;
  snrDb: number;
  preamble: boolean;
  sync: boolean;
  crc: boolean | null;
}

function goertzel(x: Float32Array, start: number, n: number, coeff: number): number {
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = x[start + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  // normalised so a full-scale sine at the probe frequency reads ~amplitude^2
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / ((n * n) / 4);
}

const dB = (p: number) => 10 * Math.log10(Math.max(p, 1e-14));

export class UltrasonicDecoder {
  readonly hop: number;
  private coeffs: number[][];
  private pending: Float32Array;
  private pendingLen = 0;
  /** Ring of per-hop carrier energies, indexed by absolute hop number. */
  private ring: Float32Array[];
  private hopCount = 0;
  private noise = 1e-9;
  private lockCandidate: { hop: number; score: number; until: number } | null = null;
  private lockedAt: number | null = null;
  private stats: DecoderStats;

  constructor(
    readonly profile: FrequencyProfile,
    readonly sampleRate: number,
  ) {
    this.hop = Math.floor(symbolSamples(sampleRate) / HOPS_PER_SYMBOL);
    this.coeffs = profile.tones.map((f) => PROBE_OFFSETS.map((o) => 2 * Math.cos((2 * Math.PI * (f + o)) / sampleRate)));
    this.pending = new Float32Array(this.hop);
    const cap = (PREAMBLE.length + SYNC.length + DATA_SYMBOLS + 4) * HOPS_PER_SYMBOL + 16;
    this.ring = Array.from({ length: cap }, () => new Float32Array(TONES));
    this.stats = { profile: profile.id, toneDb: [-140, -140, -140, -140], noiseDb: -140, snrDb: 0, preamble: false, sync: false, crc: null };
  }

  getStats(): DecoderStats {
    return this.stats;
  }

  /** Feed any number of mono samples. Returns the events they produced. */
  push(samples: Float32Array): DecoderEvent[] {
    const events: DecoderEvent[] = [];
    let i = 0;
    while (i < samples.length) {
      const take = Math.min(this.hop - this.pendingLen, samples.length - i);
      this.pending.set(samples.subarray(i, i + take), this.pendingLen);
      this.pendingLen += take;
      i += take;
      if (this.pendingLen === this.hop) {
        this.pendingLen = 0;
        this.processHop(events);
      }
    }
    return events;
  }

  private processHop(events: DecoderEvent[]) {
    const e = this.ring[this.hopCount % this.ring.length];
    for (let t = 0; t < TONES; t++) {
      let best = 0;
      for (const c of this.coeffs[t]) best = Math.max(best, goertzel(this.pending, 0, this.hop, c));
      e[t] = best;
    }
    const h = this.hopCount++;
    if (h < HOPS_PER_SYMBOL) return;

    const sym = this.symbolAt(h);
    const others = (sym.sum - sym.energy) / (TONES - 1);
    // Track the band's noise floor only while nothing is being decoded (the preamble re-calibrates it).
    if (this.lockedAt === null && !this.lockCandidate) this.noise = this.noise * 0.97 + Math.max(others, 1e-14) * 0.03;
    this.stats.toneDb = sym.levels.map(dB);
    this.stats.noiseDb = dB(this.noise);
    this.stats.snrDb = dB(sym.energy) - dB(this.noise);

    if (this.lockedAt !== null) {
      this.tryDecode(h, events);
      return;
    }

    const score = this.preambleScore(h);
    if (score > 0) {
      if (!this.lockCandidate) {
        this.lockCandidate = { hop: h, score, until: h + HOPS_PER_SYMBOL };
        events.push({ type: "signal", confidence: Math.min(1, score / (PREAMBLE.length * 12)) });
      } else if (score > this.lockCandidate.score) {
        this.lockCandidate.hop = h;
        this.lockCandidate.score = score;
      }
    }
    if (this.lockCandidate && h >= this.lockCandidate.until) {
      this.lockedAt = this.lockCandidate.hop;
      this.lockCandidate = null;
      this.stats.preamble = true;
      this.stats.sync = false;
      this.stats.crc = null;
      events.push({ type: "preamble" });
    }
  }

  /** Energies of the symbol window ending at hop `h` (inclusive). */
  private symbolAt(h: number) {
    const levels = [0, 0, 0, 0];
    for (let k = 0; k < HOPS_PER_SYMBOL; k++) {
      const e = this.ring[(h - k) % this.ring.length];
      for (let t = 0; t < TONES; t++) levels[t] += e[t] / HOPS_PER_SYMBOL;
    }
    let idx = 0;
    for (let t = 1; t < TONES; t++) if (levels[t] > levels[idx]) idx = t;
    const sum = levels[0] + levels[1] + levels[2] + levels[3];
    return { idx, energy: levels[idx], sum, levels };
  }

  /** Score > 0 only if every preamble symbol ending at the right offsets is clear and correct. */
  private preambleScore(h: number): number {
    let score = 0;
    for (let k = 0; k < PREAMBLE.length; k++) {
      const end = h - (PREAMBLE.length - 1 - k) * HOPS_PER_SYMBOL;
      if (end < HOPS_PER_SYMBOL - 1 || h - end >= this.ring.length - HOPS_PER_SYMBOL) return 0;
      const s = this.symbolAt(end);
      const others = (s.sum - s.energy) / (TONES - 1);
      const contrast = s.energy / Math.max(others, 1e-14);
      if (s.idx !== PREAMBLE[k] || contrast < PREAMBLE_CONTRAST || s.energy < this.noise * PREAMBLE_OVER_NOISE) return 0;
      score += Math.min(contrast, 40);
    }
    return score;
  }

  private tryDecode(h: number, events: DecoderEvent[]) {
    const L = this.lockedAt!;
    const total = (SYNC.length + DATA_SYMBOLS) * HOPS_PER_SYMBOL;
    // wait until the whole packet (plus a hop of timing slack) has arrived
    if (h < L + total + 1) return;
    this.lockedAt = null;

    let syncSeen = false;
    // Search a little around the locked timing; take the first alignment that passes sync AND CRC.
    for (const off of [0, -1, 1, -2, 2]) {
      const base = L + off;
      const sync: number[] = [];
      for (let k = 0; k < SYNC.length; k++) sync.push(this.symbolAt(base + (k + 1) * HOPS_PER_SYMBOL).idx);
      if (sync.some((s, k) => s !== SYNC[k])) continue;
      syncSeen = true;
      const data: number[] = [];
      for (let k = 0; k < DATA_SYMBOLS; k++) data.push(this.symbolAt(base + (SYNC.length + k + 1) * HOPS_PER_SYMBOL).idx);
      const packet = decodeDataSymbols(data);
      if (packet) {
        this.stats.sync = true;
        this.stats.crc = true;
        events.push({ type: "packet", packet, profile: this.profile.id });
        return;
      }
    }
    this.stats.sync = syncSeen;
    this.stats.crc = syncSeen ? false : null;
    events.push(syncSeen ? { type: "crc-failed" } : { type: "sync-failed" });
  }
}

/** Mean energy at a few probe frequencies over a buffer: used for capability checks and calibration. */
export function bandLevel(x: Float32Array, sampleRate: number, freqs: number[]): number {
  if (x.length === 0) return 0;
  let sum = 0;
  for (const f of freqs) sum += goertzel(x, 0, x.length, 2 * Math.cos((2 * Math.PI * f) / sampleRate));
  return sum / freqs.length;
}

export { dB as toDb };
