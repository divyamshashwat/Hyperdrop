import { dedupeNames, sanitizeFileName } from "../files/file-utils";
import { MemorySink, type FileSink, type ManifestFile, type ReceivedFile } from "../files/sink";
import { totalChunksFor, readChunks, chunkLength } from "./chunker";
import type { HasherFactory } from "./checksum";
import { ChannelClosedError, type TransferLink } from "./data-channel";
import { decodeFrame, encodeFrame, newTransferId, type Control } from "./protocol";
import { DEFAULT_TUNING, type Tuning } from "./tuning";

/**
 * Transfer engines. They know nothing about WebRTC or React: they speak the
 * protocol over a `TransferLink`, which is re-attached after reconnects so a
 * transfer can resume from the receiver's last contiguous chunk.
 */

export interface Progress {
  bytes: number;
  totalBytes: number;
  currentIndex: number | null;
  currentName: string | null;
  currentBytes: number;
  currentSize: number;
  filesDone: number;
  fileCount: number;
}

/* ------------------------------------------------------------------ sender */

export interface SenderCallbacks {
  /** Called on every accept; `isResume` is true after the first one. */
  onAccepted(resumedFromBytes: number, isResume: boolean): void;
  onProgress(p: Progress): void;
  /** All bytes handed to the channel; waiting for the receiver's verdict. */
  onFinalizing(): void;
  onVerified(): void;
  onRejected(): void;
  onCancelled(reason: string): void;
  onFailed(reason: "verification-failed" | "protocol" | "read-error"): void;
}

export class TransferSender {
  readonly transferId = newTransferId();
  readonly totalBytes: number;
  private link: TransferLink | null = null;
  private abort: AbortController | null = null;
  private run: Promise<void> = Promise.resolve();
  private accepted = false;
  private ended = false;
  private verifiedByReceiver = false;
  private sent = 0;
  private acked = 0;
  private filesDone = 0;
  private ackWaiters: Array<() => void> = [];

  constructor(
    private files: File[],
    private chunkSize: number,
    private hasher: HasherFactory,
    private cb: SenderCallbacks,
    /** Flow-control knobs; omitted fields fall back to the shipped defaults. */
    private tuning: Partial<Tuning> = {},
  ) {
    this.totalBytes = files.reduce((n, f) => n + f.size, 0);
  }

  get ackedBytes() {
    return this.acked;
  }

  /** Bytes handed to the channel that the receiver has not yet confirmed storing. */
  get inFlightBytes() {
    return Math.max(0, this.sent - this.acked);
  }

  private get window() {
    const w = this.tuning.window ?? DEFAULT_TUNING.window;
    // Never smaller than two ACK intervals, or the sender could wait for an ACK the receiver hasn't reached yet.
    return w > 0 ? Math.max(w, 2 * ACK_BYTES) : 0;
  }

  /** Sleeps until the next ACK arrives (or the pump is aborted). Never a per-chunk wait. */
  private waitForAck(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        signal.removeEventListener("abort", wake);
        resolve();
      };
      signal.addEventListener("abort", wake);
      this.ackWaiters.push(wake);
    });
  }

  private wakeAckWaiters() {
    for (const w of this.ackWaiters.splice(0)) w();
  }

  /** (Re)announce the transfer on a fresh channel. The receiver answers with where to resume. */
  attach(link: TransferLink) {
    this.link = link;
    link.configure({
      highWater: this.tuning.highWater ?? DEFAULT_TUNING.highWater,
      lowWater: this.tuning.lowWater ?? DEFAULT_TUNING.lowWater,
      pollMs: this.tuning.pollMs ?? DEFAULT_TUNING.pollMs,
    });
    if (this.ended || this.verifiedByReceiver) return;
    link.sendControl({
      type: "transfer-start",
      transferId: this.transferId,
      chunkSize: this.chunkSize,
      totalBytes: this.totalBytes,
      files: this.files.map((f) => ({
        name: f.name,
        size: f.size,
        mime: f.type,
        lastModified: f.lastModified,
        totalChunks: totalChunksFor(f.size, this.chunkSize),
      })),
    });
  }

  detach() {
    this.abort?.abort();
    this.link = null;
  }

  handleControl(msg: Control) {
    if (this.ended || ("transferId" in msg && msg.transferId !== this.transferId)) return;
    switch (msg.type) {
      case "accept": {
        const have = this.files.map((f, i) =>
          Math.min(msg.have[i] ?? 0, totalChunksFor(f.size, this.chunkSize)),
        );
        const verified = new Set(msg.verified);
        const resumed = this.files.reduce(
          (n, f, i) => n + (verified.has(i) ? f.size : Math.min(f.size, have[i] * this.chunkSize)),
          0,
        );
        this.cb.onAccepted(resumed, this.accepted);
        this.accepted = true;
        this.start(have, verified);
        break;
      }
      case "reject":
        this.ended = true;
        this.cb.onRejected();
        break;
      case "ack":
        this.acked = Math.max(this.acked, msg.bytes ?? msg.chunk * this.chunkSize);
        this.wakeAckWaiters();
        break;
      case "transfer-verified":
        this.verifiedByReceiver = true;
        this.ended = true;
        if (msg.ok) this.cb.onVerified();
        else this.cb.onFailed("verification-failed");
        break;
      case "cancel":
        this.ended = true;
        this.abort?.abort();
        this.cb.onCancelled(msg.reason);
        break;
      default:
        break;
    }
  }

  cancel(reason = "sender-cancelled") {
    if (this.ended) return;
    this.ended = true;
    this.abort?.abort();
    try {
      this.link?.sendControl({ type: "cancel", transferId: this.transferId, reason });
    } catch {
      /* peer already gone */
    }
  }

  private start(have: number[], verified: Set<number>) {
    this.abort?.abort();
    const prev = this.run;
    const ctrl = new AbortController();
    this.abort = ctrl;
    this.run = prev
      .catch(() => {})
      .then(() => this.pump(have, verified, ctrl.signal))
      .catch((err) => {
        if (err instanceof ChannelClosedError || ctrl.signal.aborted) return; // resumable
        this.ended = true;
        this.cb.onFailed("read-error");
      });
  }

  private report(index: number | null, currentBytes: number) {
    const bytes = Math.max(0, this.sent - (this.link?.buffered ?? 0));
    this.cb.onProgress({
      bytes: Math.min(bytes, this.totalBytes),
      totalBytes: this.totalBytes,
      currentIndex: index,
      currentName: index === null ? null : this.files[index].name,
      currentBytes: currentBytes,
      currentSize: index === null ? 0 : this.files[index].size,
      filesDone: this.filesDone,
      fileCount: this.files.length,
    });
  }

  private async pump(have: number[], verified: Set<number>, signal: AbortSignal) {
    const link = this.link;
    if (!link) return;
    const cs = this.chunkSize;
    this.sent = this.files.reduce(
      (n, f, i) => n + (verified.has(i) ? f.size : Math.min(f.size, have[i] * cs)),
      0,
    );
    this.acked = this.sent; // everything the receiver already holds counts as confirmed
    this.filesDone = verified.size;
    this.report(null, 0);

    for (let i = 0; i < this.files.length; i++) {
      if (verified.has(i)) continue;
      const file = this.files[i];
      const total = totalChunksFor(file.size, cs);
      const start = have[i];
      link.sendControl({ type: "file-start", transferId: this.transferId, index: i, startChunk: start });

      const hasher = this.hasher();
      // The receiver already has chunks [0, start): re-read them locally so the final digest covers the whole file.
      if (start > 0) {
        for await (const c of readChunks(file, cs, 0, start)) {
          if (signal.aborted) throw new ChannelClosedError();
          hasher.update(c.data);
        }
      }
      for await (const c of readChunks(file, cs, start, total)) {
        await link.drain(signal); // backpressure: wait for the browser's queue to drain
        // Sliding window: many chunks in flight, throttled only by unconfirmed *bytes*.
        const win = this.window;
        while (win > 0 && this.sent - this.acked >= win) {
          if (signal.aborted) throw new ChannelClosedError();
          await this.waitForAck(signal);
        }
        if (signal.aborted) throw new ChannelClosedError();
        link.sendBinary(encodeFrame(i, c.index, c.data));
        hasher.update(c.data);
        this.sent += c.data.length;
        this.report(i, Math.min(file.size, c.index * cs + c.data.length));
      }
      const sha256 = await hasher.digest();
      if (signal.aborted) throw new ChannelClosedError();
      link.sendControl({ type: "file-complete", transferId: this.transferId, index: i, sha256 });
      this.filesDone++;
      this.report(i, file.size);
    }
    this.cb.onFinalizing();
    link.sendControl({ type: "transfer-complete", transferId: this.transferId });
  }
}

/* ---------------------------------------------------------------- receiver */

export interface Manifest {
  transferId: string;
  chunkSize: number;
  totalBytes: number;
  files: ManifestFile[];
}

export interface ReceiverCallbacks {
  onOffer(m: Manifest): void;
  onProgress(p: Progress): void;
  onFinalizing(): void;
  onComplete(files: ReceivedFile[]): void;
  onCancelled(reason: string): void;
  onFailed(reason: "verification-failed" | "protocol" | "storage"): void;
}

interface FileState {
  meta: ManifestFile;
  nextChunk: number;
  bytes: number;
  began: boolean;
  verified: boolean;
  failed: boolean;
  hasher: ReturnType<HasherFactory> | null;
  result: ReceivedFile | null;
}

/** Cumulative ACK cadence (bytes). Small enough to keep the window moving, rare enough to be free. */
const ACK_BYTES = 512 * 1024;

export class TransferReceiver {
  private link: TransferLink | null = null;
  private manifest: Manifest | null = null;
  private files: FileState[] = [];
  private sink: FileSink | null = null;
  private state: "idle" | "offered" | "receiving" | "complete" | "rejected" | "ended" = "idle";
  private current: number | null = null;
  private received = 0;
  private lastAckBytes = 0;
  private chain: Promise<void> = Promise.resolve();
  private finalizingSent = false;

  constructor(
    private hasher: HasherFactory,
    private cb: ReceiverCallbacks,
  ) {}

  get phase() {
    return this.state;
  }

  get receivedBytes() {
    return this.received;
  }

  attach(link: TransferLink) {
    this.link = link;
  }

  detach() {
    this.link = null;
  }

  /** Called for every control message; processing is serialized with binary frames. */
  handleControl(msg: Control) {
    this.chain = this.chain.then(() => this.processControl(msg)).catch(() => this.fail("protocol"));
  }

  handleBinary(buf: ArrayBuffer) {
    this.chain = this.chain.then(() => this.processBinary(buf)).catch(() => this.fail("protocol"));
  }

  /** The user said yes. Nothing is stored before this. */
  accept(createSink: (files: ManifestFile[]) => FileSink = (f) => new MemorySink(f)) {
    if (this.state !== "offered" || !this.manifest) return;
    this.sink = createSink(this.manifest.files);
    this.state = "receiving";
    this.sendAccept();
  }

  reject() {
    if (!this.manifest) return;
    this.state = "rejected";
    this.safeSend({ type: "reject", transferId: this.manifest.transferId });
  }

  cancel(reason = "receiver-cancelled") {
    if (this.state === "ended" || this.state === "complete") return;
    if (this.manifest) this.safeSend({ type: "cancel", transferId: this.manifest.transferId, reason });
    this.state = "ended";
    void this.sink?.abort();
  }

  private safeSend(msg: Control) {
    try {
      this.link?.sendControl(msg);
    } catch {
      /* channel closed: the sender will re-announce on reconnect */
    }
  }

  private sendAccept() {
    if (!this.manifest) return;
    this.safeSend({
      type: "accept",
      transferId: this.manifest.transferId,
      have: this.files.map((f) => f.nextChunk),
      verified: this.files.flatMap((f, i) => (f.verified ? [i] : [])),
    });
  }

  private fail(reason: "verification-failed" | "protocol" | "storage") {
    if (this.state === "ended" || this.state === "complete") return;
    this.state = "ended";
    if (this.manifest) this.safeSend({ type: "cancel", transferId: this.manifest.transferId, reason });
    void this.sink?.abort();
    this.cb.onFailed(reason);
  }

  private progress(): Progress {
    const m = this.manifest!;
    const cur = this.current === null ? null : this.files[this.current];
    return {
      bytes: this.received,
      totalBytes: m.totalBytes,
      currentIndex: this.current,
      currentName: cur?.meta.name ?? null,
      currentBytes: cur?.bytes ?? 0,
      currentSize: cur?.meta.size ?? 0,
      filesDone: this.files.filter((f) => f.verified).length,
      fileCount: this.files.length,
    };
  }

  /** A finished transfer leaves the session open: the sender may start another batch. */
  private resetForNext() {
    this.manifest = null;
    this.files = [];
    this.sink = null;
    this.state = "idle";
    this.current = null;
    this.received = 0;
    this.lastAckBytes = 0;
    this.finalizingSent = false;
  }

  private async processControl(msg: Control) {
    if (
      this.state === "complete" &&
      msg.type === "transfer-start" &&
      msg.transferId !== this.manifest?.transferId
    ) {
      this.resetForNext();
    }
    if (this.state === "ended" || this.state === "complete") {
      // A finished transfer may be re-announced after a reconnect: repeat the verdict.
      if (
        msg.type === "transfer-start" &&
        this.state === "complete" &&
        this.manifest?.transferId === msg.transferId
      ) {
        this.safeSend({ type: "transfer-verified", transferId: msg.transferId, ok: true, failed: [] });
      }
      return;
    }
    switch (msg.type) {
      case "transfer-start": {
        if (this.manifest && this.manifest.transferId === msg.transferId) {
          if (this.state === "receiving") this.sendAccept(); // resume
          return;
        }
        if (this.manifest && this.state !== "idle") {
          this.safeSend({ type: "reject", transferId: msg.transferId });
          return;
        }
        const sum = msg.files.reduce((n, f) => n + f.size, 0);
        const consistent =
          sum === msg.totalBytes &&
          msg.files.every((f) => f.totalChunks === totalChunksFor(f.size, msg.chunkSize));
        if (!consistent) {
          this.fail("protocol");
          return;
        }
        const names = dedupeNames(msg.files.map((f) => sanitizeFileName(f.name)));
        const files: ManifestFile[] = msg.files.map((f, index) => ({
          index,
          name: names[index],
          size: f.size,
          mime: f.mime,
          lastModified: f.lastModified,
          totalChunks: f.totalChunks,
        }));
        this.manifest = { transferId: msg.transferId, chunkSize: msg.chunkSize, totalBytes: msg.totalBytes, files };
        this.files = files.map((meta) => ({
          meta,
          nextChunk: 0,
          bytes: 0,
          began: false,
          verified: false,
          failed: false,
          hasher: null,
          result: null,
        }));
        this.state = "offered";
        this.cb.onOffer(this.manifest);
        return;
      }
      case "file-start": {
        const f = this.fileFor(msg.transferId, msg.index);
        if (!f || msg.startChunk !== f.nextChunk) return this.fail("protocol");
        this.current = msg.index;
        if (!f.began) {
          await this.sink!.begin(msg.index);
          f.began = true;
          f.hasher = this.hasher();
        }
        return;
      }
      case "file-complete": {
        const f = this.fileFor(msg.transferId, msg.index);
        if (!f) return this.fail("protocol");
        if (f.verified) {
          this.safeSend({ type: "file-verified", transferId: msg.transferId, index: msg.index, ok: true });
          return;
        }
        if (!f.began) await this.beginEmpty(f);
        const complete = f.nextChunk === f.meta.totalChunks && f.bytes === f.meta.size;
        const digest = complete && f.hasher ? await f.hasher.digest() : "";
        if (complete && digest === msg.sha256) {
          f.result = await this.sink!.finish(msg.index);
          f.verified = true;
        } else {
          f.failed = true;
        }
        this.safeSend({ type: "file-verified", transferId: msg.transferId, index: msg.index, ok: f.verified });
        return;
      }
      case "transfer-complete": {
        if (this.state !== "receiving" || msg.transferId !== this.manifest?.transferId) return;
        const failed = this.files.flatMap((f, i) => (f.verified ? [] : [i]));
        this.safeSend({ type: "transfer-verified", transferId: msg.transferId, ok: failed.length === 0, failed });
        if (failed.length === 0) {
          this.state = "complete";
          this.cb.onComplete(this.files.map((f) => f.result!));
        } else {
          this.fail("verification-failed");
        }
        return;
      }
      case "cancel":
        if (msg.transferId !== this.manifest?.transferId) return;
        this.state = "ended";
        void this.sink?.abort();
        this.cb.onCancelled(msg.reason);
        return;
      default:
        return;
    }
  }

  /** Zero-byte files never see `file-start` data frames but still need a sink entry. */
  private async beginEmpty(f: FileState) {
    await this.sink!.begin(f.meta.index);
    f.began = true;
    f.hasher = this.hasher();
  }

  private fileFor(transferId: string, index: number): FileState | null {
    if (this.state !== "receiving" || transferId !== this.manifest?.transferId) return null;
    return this.files[index] ?? null;
  }

  private async processBinary(buf: ArrayBuffer) {
    // Data before the user accepts, or outside a file, is dropped.
    if (this.state !== "receiving" || this.current === null || !this.manifest) return;
    const frame = decodeFrame(buf);
    const f = this.files[this.current];
    if (!frame || !f || frame.fileIndex !== this.current || frame.chunkIndex !== f.nextChunk) {
      return this.fail("protocol");
    }
    const expected = chunkLength(frame.chunkIndex, f.meta.size, this.manifest.chunkSize);
    if (frame.chunkIndex >= f.meta.totalChunks || frame.payload.length !== expected) return this.fail("protocol");

    try {
      await this.sink!.write(f.meta.index, frame.payload);
    } catch {
      return this.fail("storage");
    }
    f.hasher!.update(frame.payload);
    f.nextChunk++;
    f.bytes += frame.payload.length;
    this.received += frame.payload.length;
    if (this.received - this.lastAckBytes >= ACK_BYTES) {
      this.lastAckBytes = this.received;
      this.safeSend({
        type: "ack",
        transferId: this.manifest.transferId,
        index: f.meta.index,
        chunk: f.nextChunk,
        bytes: this.received,
      });
    }
    this.cb.onProgress(this.progress());
    if (this.received >= this.manifest.totalBytes && !this.finalizingSent) {
      this.finalizingSent = true;
      this.cb.onFinalizing();
    }
  }
}

