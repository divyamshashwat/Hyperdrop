/** Simulated air path for Nearby calibration: room echo, speech noise, mic self-noise, real decoder. */
import { ToneDecoder } from "../../src/lib/proximity/decoder";
import { renderSymbols, type FrequencyProfile } from "../../src/lib/proximity/modulation";
import { PROTOCOL_VERSION, encodePacket } from "../../src/lib/proximity/protocol";
import { gaussian, rms, type Rng } from "./speech";

export const RATE = 48000;

/**
 * Sparse room impulse response: direct path, a few early reflections, and a diffuse
 * tail decaying with RT60 0.45 s (furnished room). Distance is set by the
 * direct-to-reverberant energy ratio: ~+12 dB at 30 cm, ~+5 dB at 1 m, ~0 dB at 2 m.
 */
export function impulse(room: RoomKind, r: Rng): Array<[number, number]> {
  const drrDb = room === "30 cm" ? 12 : room === "1 m" ? 5 : 0;
  const early: Array<[number, number]> = [
    [between(r, 2, 5), 0.6],
    [between(r, 6, 12), 0.5],
    [between(r, 12, 20), 0.4],
  ];
  const late: Array<[number, number]> = [];
  const rt60 = 0.45;
  for (let i = 0; i < 70; i++) {
    const ms = 20 + r() * 420;
    late.push([ms, (r() < 0.5 ? -1 : 1) * Math.pow(10, (-3 * ms) / 1000 / rt60)]);
  }
  // scale all reflections together so their energy sits drrDb below the direct path
  const reflected = [...early, ...late];
  const energy = reflected.reduce((a, [, g]) => a + g * g, 0);
  const k = Math.sqrt(Math.pow(10, -drrDb / 10) / energy);
  return [[0, 1], ...reflected.map(([ms, g]) => [ms, g * k] as [number, number])];
}

const between = (r: Rng, a: number, b: number) => a + (b - a) * r();

function convolve(x: Float32Array, taps: Array<[number, number]>, extra: number): Float32Array {
  const out = new Float32Array(x.length + extra);
  for (const [ms, g] of taps) {
    const d = Math.round((RATE * ms) / 1000);
    for (let i = 0; i < x.length && i + d < out.length; i++) out[i + d] += x[i] * g;
  }
  return out;
}

export type RoomKind = "30 cm" | "1 m" | "2 m";

/** One trial: did this packet, played into this noise, decode to the right token? Events kept for debugging. */
export function trial(
  profile: FrequencyProfile,
  cell: { speechDb: number; room: RoomKind },
  bank: Float32Array,
  r: Rng,
): { ok: boolean; events: string[] } {
  const token = Math.floor(r() * 0x100000000) >>> 0;
  const dry = renderSymbols(encodePacket({ version: PROTOCOL_VERSION, flags: 0, token }), profile, RATE, 1);
  const wet = convolve(dry, impulse(cell.room, r), Math.round(RATE * 0.45));
  const lead = Math.round(RATE * (0.3 + r() * 0.6)); // listener was already running
  const total = lead + wet.length + Math.round(RATE * 0.3);
  const sigLevel = 0.02; // chirp ~ -34 dBFS at the mic
  const sigGain = sigLevel / rms(dry);
  const noiseGain = sigLevel * Math.pow(10, cell.speechDb / 20); // bank is RMS 1
  const off = Math.floor(r() * (bank.length - total));
  const x = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const s = i >= lead && i - lead < wet.length ? wet[i - lead] * sigGain : 0;
    const v = s + bank[off + i] * noiseGain + 0.0005 * gaussian(r); // + mic self-noise ~ -66 dBFS
    x[i] = Math.max(-1, Math.min(1, v));
  }
  const dec = new ToneDecoder(profile, RATE);
  const events: string[] = [];
  for (let i = 0; i < x.length; i += 2048) {
    for (const e of dec.push(x.subarray(i, Math.min(x.length, i + 2048)))) {
      events.push(e.type);
      if (e.type === "packet" && e.packet.payload.token === token) return { ok: true, events };
    }
  }
  return { ok: false, events };
}
