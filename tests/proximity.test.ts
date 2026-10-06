import { describe, expect, it } from "vitest";
import { UltrasonicDecoder, type DecoderEvent } from "@/lib/proximity/decoder";
import { PROFILES, chooseOutputProfile, profilesForCapture, renderSymbols, symbolSamples } from "@/lib/proximity/modulation";
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

function run(decoder: UltrasonicDecoder, x: Float32Array, chunk = 1024): DecoderEvent[] {
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
    expect(chooseOutputProfile(48000)?.id).toBe("ultrasonic-low");
    expect(chooseOutputProfile(44100)?.id).toBe("ultrasonic-low");
    expect(chooseOutputProfile(16000)).toBeNull();
    expect(profilesForCapture(44100).map((p) => p.id)).toEqual(["ultrasonic-low"]);
    expect(profilesForCapture(48000).map((p) => p.id)).toEqual(["ultrasonic-low"]);
    expect(profilesForCapture(16000)).toEqual([]);
  });

  it("stays inside the measured iPhone passband (20.0-21.0 kHz detected, 21.5 kHz not)", () => {
    for (const p of PROFILES) for (const f of p.tones) expect(f).toBeLessThan(21_100);
  });

  it("keeps every carrier above 20 kHz and below Nyquist", () => {
    for (const p of PROFILES) {
      for (const f of p.tones) {
        expect(f).toBeGreaterThan(20000);
        expect(f).toBeLessThan(p.minSampleRate / 2);
      }
    }
  });

  it("a packet lasts under 2.5 seconds", () => {
    const seconds = (symbolSamples(48000) * PACKET_SYMBOLS) / 48000;
    expect(seconds).toBeLessThan(2.5);
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
        const events = run(new UltrasonicDecoder(profile, rate), x);
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
    const ok = run(new UltrasonicDecoder(profile, rate), x).find((e) => e.type === "packet");
    expect(ok).toBeTruthy();
  });

  it("never pairs on noise, speech-band content, sweeps or a steady ultrasonic tone", () => {
    const rate = 48000;
    const r = rng(42);
    const seconds = 12;
    const x = new Float32Array(rate * seconds);
    for (let i = 0; i < x.length; i++) {
      const t = i / rate;
      x[i] =
        0.05 * gaussian(r) + // broadband noise / fan
        0.2 * Math.sin(2 * Math.PI * (300 + 200 * Math.sin(t * 3)) * t) + // speech-ish formant motion
        0.05 * Math.sin(2 * Math.PI * (18000 + 600 * t) * t) + // a slow sweep through the band
        (t > 6 && t < 9 ? 0.15 * Math.sin(2 * Math.PI * 21000 * t) : 0); // a steady 21 kHz whine
    }
    for (const profile of PROFILES) {
      const events = run(new UltrasonicDecoder(profile, rate), x);
      expect(events.filter((e) => e.type === "packet")).toHaveLength(0);
    }
  });

  it("decodes a repeated packet once per transmission and ignores the gap", () => {
    const rate = 48000;
    const profile = PROFILES[0];
    const one = renderSymbols(encodePacket(PAYLOAD), profile, rate, 0.25, 220);
    const twice = new Float32Array(one.length * 2);
    twice.set(one);
    twice.set(one, one.length);
    const events = run(new UltrasonicDecoder(profile, rate), airPath(twice, rate));
    expect(events.filter((e) => e.type === "packet")).toHaveLength(2);
  });
});
