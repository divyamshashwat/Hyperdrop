import { describe, expect, it } from "vitest";
import { ToneDecoder, type DecoderEvent } from "@/lib/proximity/decoder";
import { GAP_MS, PROFILES, chooseOutputProfile, profilesForCapture, renderSymbols, symbolSamples } from "@/lib/proximity/modulation";
import {
  DATA_SYMBOLS,
  PACKET_SYMBOLS,
  PREAMBLE,
  SYNC,
  addCRC,
  addErrorCorrection,
  checkCRC,
  crc16,
  decodeDataSymbols,
  deinterleaveBits,
  encodePacket,
  hammingDecode,
  hammingEncode,
  interleaveBits,
  serializePayload,
} from "@/lib/proximity/protocol";

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

function gaussian(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

function run(decoder: ToneDecoder, x: Float32Array, chunk = 1024): DecoderEvent[] {
  const events: DecoderEvent[] = [];
  for (let i = 0; i < x.length; i += chunk) events.push(...decoder.push(x.subarray(i, Math.min(x.length, i + chunk))));
  return events;
}

/** Packet through a crude "air path": attenuation, delay, broadband noise, a little hum. */
function airPath(packet: Float32Array, sampleRate: number, opts: { gain?: number; noise?: number; leadMs?: number; seed?: number } = {}) {
  const r = rng(opts.seed ?? 7);
  const lead = Math.round((sampleRate * (opts.leadMs ?? 137)) / 1000);
  const out = new Float32Array(lead + packet.length + sampleRate / 4);
  for (let i = 0; i < out.length; i++) {
    const s = i >= lead && i - lead < packet.length ? packet[i - lead] * (opts.gain ?? 0.2) : 0;
    out[i] = s + (opts.noise ?? 0.01) * gaussian(r) + 0.02 * Math.sin((2 * Math.PI * 120 * i) / sampleRate);
  }
  return out;
}

const PAYLOAD = { version: 1, flags: 0, token: 0xa1b2c3d4 };

describe("nearby protocol", () => {
  it("CRC-16/CCITT-FALSE matches the reference vector", () => {
    expect(crc16(new TextEncoder().encode("123456789"))).toBe(0x29b1);
  });

  it("Hamming(7,4) corrects any single-bit error", () => {
    for (let n = 0; n < 16; n++) {
      const c = hammingEncode(n);
      expect(hammingDecode(c).nibble).toBe(n);
      for (let b = 0; b < 7; b++) {
        const bad = c.slice();
        bad[b] ^= 1;
        expect(hammingDecode(bad)).toEqual({ nibble: n, corrected: true });
      }
    }
  });

  it("interleaving round-trips", () => {
    const words = addErrorCorrection(addCRC(serializePayload(PAYLOAD)));
    expect(deinterleaveBits(interleaveBits(words))).toEqual(words);
  });

  it("encodes a packet of the documented shape", () => {
    const p = encodePacket(PAYLOAD);
    expect(p).toHaveLength(PACKET_SYMBOLS);
    expect(p.slice(0, PREAMBLE.length)).toEqual([...PREAMBLE]);
    expect(p.slice(PREAMBLE.length, PREAMBLE.length + SYNC.length)).toEqual([...SYNC]);
  });

  it("survives a burst of 7 corrupted data symbols (interleaving + FEC)", () => {
    const data = encodePacket(PAYLOAD).slice(PREAMBLE.length + SYNC.length);
    for (let start = 0; start + 7 <= DATA_SYMBOLS; start += 6) {
      const bad = data.slice();
      for (let k = start; k < start + 7; k++) bad[k] = (bad[k] + 1) % 4; // neighbouring tone: one bit flip (Gray)
      expect(decodeDataSymbols(bad)?.payload.token).toBe(PAYLOAD.token);
    }
  });

  it("rejects payloads it cannot verify rather than guessing", () => {
    const data = encodePacket(PAYLOAD).slice(PREAMBLE.length + SYNC.length);
    const wrecked = data.map((s, i) => (i % 2 ? (s + 2) % 4 : s));
    expect(decodeDataSymbols(wrecked)).toBeNull();
    const bytes = addCRC(serializePayload(PAYLOAD));
    bytes[2] ^= 0x10;
    expect(checkCRC(bytes)).toBeNull();
  });
});

describe("frequency profiles", () => {
  it("are chosen from the real sample rate, never assumed", () => {
    expect(chooseOutputProfile(48000)?.id).toBe("audible");
    expect(chooseOutputProfile(44100)?.id).toBe("audible");
    expect(chooseOutputProfile(16000)?.id).toBe("audible");
    expect(chooseOutputProfile(8000)).toBeNull();
    expect(profilesForCapture(44100).map((p) => p.id)).toEqual(["audible"]);
    expect(profilesForCapture(16000).map((p) => p.id)).toEqual(["audible"]);
    expect(profilesForCapture(8000)).toEqual([]);
  });

  it("keeps every carrier in the band small speakers and phone mics reproduce, below Nyquist", () => {
    for (const p of PROFILES) {
      for (const f of p.tones) {
        expect(f).toBeGreaterThanOrEqual(2000);
        expect(f).toBeLessThanOrEqual(5000);
        expect(f).toBeLessThan(p.minSampleRate / 2);
      }
    }
  });

  it("no carrier is a harmonic of another", () => {
    for (const p of PROFILES) for (const a of p.tones) for (const b of p.tones) if (b > a) expect(b % a).not.toBe(0);
  });

  it("a packet lasts under 3.5 seconds", () => {
    const seconds = (symbolSamples(48000) * PACKET_SYMBOLS) / 48000;
    expect(seconds).toBeLessThan(3.5);
    expect(seconds).toBeGreaterThan(1);
  });
});

describe("streaming decoder", () => {
  for (const [rate, profile] of [
    [48000, PROFILES[0]],
    [44100, PROFILES[0]],
  ] as const) {
    it(`decodes ${profile.id} at ${rate} Hz through noise, delay and attenuation`, () => {
      const pcm = renderSymbols(encodePacket(PAYLOAD), profile, rate, 0.25);
      for (const seed of [1, 2, 3]) {
        const x = airPath(pcm, rate, { gain: 0.15, noise: 0.01, leadMs: 90 + seed * 37, seed });
        const events = run(new ToneDecoder(profile, rate), x);
        const packet = events.find((e) => e.type === "packet");
        expect(packet && packet.type === "packet" && packet.packet.payload.token).toBe(PAYLOAD.token);
      }
    });
  }

  it("still decodes when a few symbols are drowned by an interfering tone", () => {
    const rate = 48000;
    const profile = PROFILES[0];
    const pcm = renderSymbols(encodePacket(PAYLOAD), profile, rate, 0.25);
    const x = airPath(pcm, rate, { gain: 0.2 });
    // a 90 ms burst sitting right on carrier 2, in the middle of the data
    const n = symbolSamples(rate);
    const at = Math.round((rate * 137) / 1000) + (PREAMBLE.length + SYNC.length + 20) * n;
    for (let i = 0; i < 3 * n; i++) x[at + i] += 0.08 * Math.sin((2 * Math.PI * profile.tones[2] * i) / rate);
    const ok = run(new ToneDecoder(profile, rate), x).find((e) => e.type === "packet");
    expect(ok).toBeTruthy();
  });

  it("decodes through room echo (reverb tail longer than a symbol)", () => {
    const rate = 48000;
    const profile = PROFILES[0];
    const dry = renderSymbols(encodePacket(PAYLOAD), profile, rate, 0.25);
    const wet = new Float32Array(dry.length + rate / 2);
    // direct path plus a few decaying reflections out to 120 ms
    for (const [ms, g] of [[0, 1], [7, 0.55], [19, 0.4], [41, 0.3], [73, 0.2], [120, 0.12]] as const) {
      const d = Math.round((rate * ms) / 1000);
      for (let i = 0; i < dry.length; i++) wet[i + d] += dry[i] * g;
    }
    const events = run(new ToneDecoder(profile, rate), airPath(wet, rate, { gain: 0.15 }));
    const packet = events.find((e) => e.type === "packet");
    expect(packet && packet.type === "packet" && packet.packet.payload.token).toBe(PAYLOAD.token);
  });

  it("never pairs on noise, speech, music-like chords, sweeps or a steady tone in the band", () => {
    const rate = 48000;
    const r = rng(42);
    const seconds = 12;
    const x = new Float32Array(rate * seconds);
    for (let i = 0; i < x.length; i++) {
      const t = i / rate;
      x[i] =
        0.05 * gaussian(r) + // broadband noise / fan
        0.2 * Math.sin(2 * Math.PI * (300 + 200 * Math.sin(t * 3)) * t) + // speech-ish formant motion
        0.05 * Math.sin(2 * Math.PI * (2000 + 150 * t) * t) + // a slow sweep through the band
        (t < 4 ? 0.08 * (Math.sin(2 * Math.PI * 2640 * t) + Math.sin(2 * Math.PI * 3300 * t) + Math.sin(2 * Math.PI * 3960 * t)) : 0) + // a held chord
        (t > 6 && t < 9 ? 0.15 * Math.sin(2 * Math.PI * 3000 * t) : 0); // a steady 3 kHz beep
    }
    for (const profile of PROFILES) {
      const events = run(new ToneDecoder(profile, rate), x);
      expect(events.filter((e) => e.type === "packet")).toHaveLength(0);
    }
  });

  it("decodes a repeated packet once per transmission and ignores the gap", () => {
    const rate = 48000;
    const profile = PROFILES[0];
    const one = renderSymbols(encodePacket(PAYLOAD), profile, rate, 0.25, GAP_MS);
    const twice = new Float32Array(one.length * 2);
    twice.set(one);
    twice.set(one, one.length);
    const events = run(new ToneDecoder(profile, rate), airPath(twice, rate));
    expect(events.filter((e) => e.type === "packet")).toHaveLength(2);
  });
});
