import type { TransferLink } from "../webrtc/data-channel";
import { BENCH_FILE_INDEX, FRAME_HEADER_BYTES, encodeFrame, newTransferId, type Control } from "../webrtc/protocol";
import type { Tuning } from "../webrtc/tuning";

/**
 * Synthetic throughput test through the exact same DataChannel and the same
 * backpressure code as a real transfer, but with no files, no hashing, no
 * storage. Comparing it to a real transfer separates "the network/WebRTC path
 * is the limit" from "our file pipeline is the limit".
 */
export interface BenchResult {
  bytes: number;
  ms: number;
  /** Decimal MB/s, end to end (sender start → receiver confirmed). */
  mbPerSec: number;
  avgBuffered: number;
  peakBuffered: number;
  chunkSize: number;
  highWater: number;
}

/** Receiver half. Always on, costs nothing when idle. */
export class BenchResponder {
  private run: { id: string; bytes: number; started: number } | null = null;

  constructor(private getLink: () => TransferLink | null) {}

  handleControl(msg: Control): boolean {
    if (msg.type === "bench-start") {
      this.run = { id: msg.id, bytes: 0, started: 0 };
      return true;
    }
    if (msg.type === "bench-end") {
      const r = this.run;
      if (r && r.id === msg.id) {
        const ms = r.started ? performance.now() - r.started : 0;
        try {
          this.getLink()?.sendControl({ type: "bench-result", id: r.id, bytes: r.bytes, ms });
        } catch {
          /* channel closed */
        }
        this.run = null;
      }
      return true;
    }
    return false;
  }

  handleFrame(buf: ArrayBuffer) {
    const r = this.run;
    if (!r) return;
    if (!r.started) r.started = performance.now();
    r.bytes += buf.byteLength - FRAME_HEADER_BYTES;
  }
}

/** Sender half. */
export class BenchRunner {
  private waiting = new Map<string, (r: { bytes: number; ms: number }) => void>();

  handleControl(msg: Control): boolean {
    if (msg.type !== "bench-result") return false;
    this.waiting.get(msg.id)?.({ bytes: msg.bytes, ms: msg.ms });
    this.waiting.delete(msg.id);
    return true;
  }

  async run(
    link: TransferLink,
    tuning: Pick<Tuning, "chunkSize" | "highWater" | "lowWater" | "pollMs">,
    totalBytes: number,
    signal?: AbortSignal,
  ): Promise<BenchResult> {
    link.configure({ highWater: tuning.highWater, lowWater: tuning.lowWater, pollMs: tuning.pollMs });
    const id = newTransferId();
    // Incompressible payload, built once and re-sent: this measures the pipe, not memory allocation.
    const payload = new Uint8Array(tuning.chunkSize);
    for (let o = 0; o < payload.length; o += 65536) crypto.getRandomValues(payload.subarray(o, Math.min(payload.length, o + 65536)));
    const frame = encodeFrame(BENCH_FILE_INDEX, 0, payload);

    const result = new Promise<{ bytes: number; ms: number }>((resolve, reject) => {
      this.waiting.set(id, resolve);
      setTimeout(() => reject(new Error("benchmark timed out")), 180_000);
    });
    link.sendControl({ type: "bench-start", id, bytes: totalBytes, chunkSize: tuning.chunkSize });

    const t0 = performance.now();
    let sent = 0;
    let bufSum = 0;
    let bufN = 0;
    let peak = 0;
    while (sent < totalBytes) {
      await link.drain(signal);
      link.sendBinary(frame);
      sent += tuning.chunkSize;
      const b = link.buffered;
      bufSum += b;
      bufN++;
      if (b > peak) peak = b;
    }
    link.sendControl({ type: "bench-end", id });
    const r = await result;
    const ms = performance.now() - t0;
    return {
      bytes: r.bytes,
      ms,
      mbPerSec: r.bytes / 1e6 / (ms / 1000),
      avgBuffered: bufN ? bufSum / bufN : 0,
      peakBuffered: peak,
      chunkSize: tuning.chunkSize,
      highWater: tuning.highWater,
    };
  }
}
