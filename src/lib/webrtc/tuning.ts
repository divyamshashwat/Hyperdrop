import { FRAME_HEADER_BYTES } from "./protocol";

/**
 * Flow-control knobs. Every default here is a hypothesis to be confirmed with the
 * synthetic benchmark on the real devices; each one can be overridden from the
 * URL (`?chunk=256&high=8&low=2&window=16`, sizes in KB / MB) so a config can be
 * A/B-tested on an iPhone without rebuilding. `window=0` disables the app window.
 */
export interface Tuning {
  /** Payload bytes per DataChannel message. */
  chunkSize: number;
  /** Stop reading new chunks above this much queued in the browser. */
  highWater: number;
  /** Resume below this (also bufferedAmountLowThreshold). */
  lowWater: number;
  /** Max unacknowledged bytes in flight (0 = off). */
  window: number;
  /** Fallback wake-up if `bufferedamountlow` is late (ms). */
  pollMs: number;
}

const KB = 1024;
const MB = 1024 * 1024;

/**
 * Shipped defaults, chosen from measurements (see docs/PERFORMANCE.md), not theory:
 * on Chrome loopback, raw WebRTC did ~15 MB/s at 64 KB, ~11.5 at 128 KB and ~10 at 255 KB,
 * and a 1 MB buffer was no different from 8 MB. So: small chunks, a modest buffer
 * (kind to iPhone memory), and a byte window that exists to bound receiver backlog,
 * not to add speed. Re-tune from the iPhone numbers with the ?chunk= / ?high= overrides.
 */
export const DEFAULT_TUNING: Tuning = {
  chunkSize: 64 * KB,
  highWater: 4 * MB,
  lowWater: 1 * MB,
  window: 8 * MB,
  pollMs: 15,
};

/** Chrome rejects send() once ~16 MB is queued ("send queue is full"); stay well under it. */
export const MAX_HIGH_WATER = 12 * MB;

/** What the engine did before this work, kept so it can be benchmarked against. */
export const LEGACY_TUNING: Tuning = {
  chunkSize: 128 * KB,
  highWater: 1 * MB,
  lowWater: 256 * KB,
  window: 0,
  pollMs: 200,
};

export function readOverrides(search: string): Partial<Tuning> {
  const q = new URLSearchParams(search);
  const num = (k: string) => {
    const v = q.get(k);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const o: Partial<Tuning> = {};
  const chunk = num("chunk");
  const high = num("high");
  const low = num("low");
  const win = num("window");
  if (chunk) o.chunkSize = chunk * KB;
  if (high) o.highWater = high * MB;
  if (low) o.lowWater = low * MB;
  if (win !== undefined) o.window = win * MB;
  const poll = num("poll");
  if (poll) o.pollMs = poll;
  return o;
}

/** Largest payload that still fits one SCTP message together with our 8-byte frame header. */
export function maxPayload(maxMessageSize?: number): number {
  const limit = maxMessageSize && Number.isFinite(maxMessageSize) ? maxMessageSize : 256 * KB;
  return Math.max(16 * KB, Math.floor((limit - FRAME_HEADER_BYTES - 8) / KB) * KB);
}

export function resolveTuning(opts: { maxMessageSize?: number; search?: string; base?: Tuning }): Tuning {
  const t = { ...(opts.base ?? DEFAULT_TUNING), ...(opts.search ? readOverrides(opts.search) : {}) };
  t.chunkSize = Math.min(t.chunkSize, maxPayload(opts.maxMessageSize));
  t.highWater = Math.min(t.highWater, MAX_HIGH_WATER);
  t.lowWater = Math.min(t.lowWater, Math.max(t.highWater / 2, t.chunkSize));
  if (t.window > 0) t.window = Math.max(t.window, t.chunkSize * 4); // never smaller than a few messages
  return t;
}
