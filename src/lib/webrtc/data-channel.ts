import { encodeControl, parseControl, type Control } from "./protocol";

/** Defaults; the live values come from `Tuning` via `configure()`. */
export const HIGH_WATER_MARK = 8 * 1024 * 1024;
export const LOW_WATER_MARK = 2 * 1024 * 1024;

/** Fallback poll if a browser is late with `bufferedamountlow`. Kept short: backpressure sets the pace. */
const POLL_MS = 15;

export class ChannelClosedError extends Error {
  constructor() {
    super("channel closed");
    this.name = "ChannelClosedError";
  }
}

/** The slice of RTCDataChannel the transfer layer needs (also implemented by test fakes). */
export interface ChannelLike extends EventTarget {
  readyState: RTCDataChannelState;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: BinaryType;
  send(data: string | ArrayBuffer): void;
}

export interface TransferLink {
  readonly open: boolean;
  readonly buffered: number;
  sendControl(msg: Control): void;
  sendBinary(buf: ArrayBuffer): void;
  /** Resolves when the outbound queue is below the high-water mark. Rejects if the channel dies. */
  drain(signal?: AbortSignal): Promise<void>;
  configure(water: { highWater: number; lowWater: number; pollMs?: number }): void;
}

export interface LinkHandlers {
  onControl(msg: Control): void;
  onBinary(buf: ArrayBuffer): void;
  onClose(): void;
}

export class DataChannelLink implements TransferLink {
  private high = HIGH_WATER_MARK;
  private low = LOW_WATER_MARK;
  private poll = POLL_MS;

  constructor(
    private ch: ChannelLike,
    handlers: LinkHandlers,
  ) {
    ch.binaryType = "arraybuffer";
    ch.bufferedAmountLowThreshold = this.low;
    ch.addEventListener("message", (e) => {
      const data = (e as MessageEvent).data;
      if (typeof data === "string") {
        const msg = parseControl(data);
        if (msg) handlers.onControl(msg);
      } else if (data instanceof ArrayBuffer) {
        handlers.onBinary(data);
      }
    });
    ch.addEventListener("close", () => handlers.onClose());
  }

  configure({ highWater, lowWater, pollMs }: { highWater: number; lowWater: number; pollMs?: number }) {
    this.high = highWater;
    this.low = lowWater;
    if (pollMs) this.poll = pollMs;
    this.ch.bufferedAmountLowThreshold = lowWater;
  }

  get open() {
    return this.ch.readyState === "open";
  }

  get buffered() {
    return this.ch.bufferedAmount;
  }

  sendControl(msg: Control) {
    if (!this.open) throw new ChannelClosedError();
    this.ch.send(encodeControl(msg));
  }

  sendBinary(buf: ArrayBuffer) {
    if (!this.open) throw new ChannelClosedError();
    this.ch.send(buf);
  }

  /**
   * Backpressure. Never call `send()` in a tight loop: wait for the browser's
   * queue to drain. Wakes on `bufferedamountlow`; a short poll covers browsers
   * that fire it late so the pipe is never left idle.
   */
  async drain(signal?: AbortSignal): Promise<void> {
    const ch = this.ch;
    if (ch.bufferedAmount <= this.high && ch.readyState === "open" && !signal?.aborted) return;
    while (ch.bufferedAmount > this.high) {
      if (ch.readyState !== "open" || signal?.aborted) throw new ChannelClosedError();
      ch.bufferedAmountLowThreshold = this.low;
      await new Promise<void>((resolve) => {
        const done = () => {
          ch.removeEventListener("bufferedamountlow", done);
          ch.removeEventListener("close", done);
          signal?.removeEventListener("abort", done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, this.poll);
        ch.addEventListener("bufferedamountlow", done);
        ch.addEventListener("close", done);
        signal?.addEventListener("abort", done);
      });
    }
    if (ch.readyState !== "open" || signal?.aborted) throw new ChannelClosedError();
  }
}
