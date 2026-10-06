import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ReceivedFile } from "@/lib/files/sink";
import { createInlineHasher } from "@/lib/webrtc/checksum";
import { DataChannelLink, HIGH_WATER_MARK, type ChannelLike } from "@/lib/webrtc/data-channel";
import { BenchResponder, BenchRunner } from "@/lib/benchmarks/synthetic";
import { parsePathStats } from "@/lib/diagnostics/stats";
import { FRAME_HEADER_BYTES, decodeFrame, isBenchFrame } from "@/lib/webrtc/protocol";
import { MAX_HIGH_WATER, resolveTuning } from "@/lib/webrtc/tuning";
import { TransferReceiver, TransferSender } from "@/lib/webrtc/transfer-manager";

/** In-memory DataChannel pair: ordered, asynchronous, with a bounded drain rate and a bufferedAmount. */
class FakeChannel extends EventTarget implements ChannelLike {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = "arraybuffer";
  peak = 0;
  delivered = 0;
  frames = 0;
  peer!: FakeChannel;
  tamper?: (n: number, buf: ArrayBuffer) => ArrayBuffer;
  private queue: Array<string | ArrayBuffer> = [];
  private pumping = false;

  constructor(private bytesPerTick = 512 * 1024) {
    super();
  }

  send(data: string | ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("closed");
    this.bufferedAmount += typeof data === "string" ? data.length : data.byteLength;
    this.peak = Math.max(this.peak, this.bufferedAmount);
    this.queue.push(data);
    if (!this.pumping) {
      this.pumping = true;
      setTimeout(() => this.pump(), 1);
    }
  }

  private pump() {
    let budget = this.bytesPerTick;
    while (this.queue.length && budget > 0 && this.readyState === "open") {
      let item = this.queue.shift()!;
      const size = typeof item === "string" ? item.length : item.byteLength;
      budget -= size;
      const was = this.bufferedAmount;
      this.bufferedAmount -= size;
      if (typeof item !== "string") {
        this.frames++;
        if (this.tamper) item = this.tamper(this.frames, item);
      }
      this.delivered += size;
      this.peer.dispatchEvent(new MessageEvent("message", { data: item }));
      if (was > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.dispatchEvent(new Event("bufferedamountlow"));
      }
    }
    if (this.queue.length && this.readyState === "open") setTimeout(() => this.pump(), 1);
    else this.pumping = false;
  }

  close() {
    for (const c of [this, this.peer]) {
      if (c.readyState === "closed") continue;
      c.readyState = "closed";
      c.queue = [];
      c.dispatchEvent(new Event("close"));
    }
  }
}

function pair(rate?: number) {
  const a = new FakeChannel(rate);
  const b = new FakeChannel(rate);
  a.peer = b;
  b.peer = a;
  return { a, b };
}

const rand = (n: number) => new File([new Uint8Array(randomBytes(n))], `IMG_${n}.HEIC`, { type: "image/heic" });
const bytesOf = async (f: File) => Buffer.from(await f.arrayBuffer());
const CHUNK = 32 * 1024;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rig {
  sender: TransferSender;
  receiver: TransferReceiver;
  result: Promise<"verified" | "failed" | "rejected">;
  received: ReceivedFile[];
  events: string[];
  connect(ch: { a: FakeChannel; b: FakeChannel }): void;
}

function rig(files: File[], opts: { autoAccept?: boolean } = {}): Rig {
  const received: ReceivedFile[] = [];
  const events: string[] = [];
  let settle!: (v: "verified" | "failed" | "rejected") => void;
  const result = new Promise<"verified" | "failed" | "rejected">((r) => (settle = r));
  const receiver = new TransferReceiver(createInlineHasher, {
    onOffer: () => {
      events.push("offer");
      if (opts.autoAccept !== false) receiver.accept();
    },
    onProgress: () => {},
    onFinalizing: () => events.push("finalizing"),
    onComplete: (f) => {
      received.push(...f);
      events.push("complete");
    },
    onCancelled: () => events.push("cancelled"),
    onFailed: (r) => events.push(`receiver-failed:${r}`),
  });
  const sender = new TransferSender(files, CHUNK, createInlineHasher, {
    onAccepted: (resumed, isResume) => events.push(isResume ? `resumed@${resumed}` : "accepted"),
    onProgress: () => {},
    onFinalizing: () => events.push("sender-finalizing"),
    onVerified: () => settle("verified"),
    onRejected: () => settle("rejected"),
    onCancelled: () => events.push("sender-cancelled"),
    onFailed: () => settle("failed"),
  });
  return {
    sender,
    receiver,
    result,
    received,
    events,
    connect({ a, b }) {
      const ls = new DataChannelLink(a, {
        onControl: (m) => sender.handleControl(m),
        onBinary: () => {},
        onClose: () => sender.detach(),
      });
      const lr = new DataChannelLink(b, {
        onControl: (m) => receiver.handleControl(m),
        onBinary: (buf) => receiver.handleBinary(buf),
        onClose: () => receiver.detach(),
      });
      receiver.attach(lr);
      sender.attach(ls);
    },
  };
}

describe("send more on a live session", () => {
  it("accepts a second batch after the first completes, with no re-pairing", async () => {
    const received: ReceivedFile[][] = [];
    const offers: string[] = [];
    const receiver = new TransferReceiver(createInlineHasher, {
      onOffer: (m) => {
        offers.push(m.transferId);
        receiver.accept();
      },
      onProgress: () => {},
      onFinalizing: () => {},
      onComplete: (f) => received.push(f),
      onCancelled: () => {},
      onFailed: () => {},
    });
    const ch = pair();
    const linkR = new DataChannelLink(ch.b, {
      onControl: (m) => receiver.handleControl(m),
      onBinary: (b) => receiver.handleBinary(b),
      onClose: () => receiver.detach(),
    });
    receiver.attach(linkR);

    const runBatch = async (files: File[]) => {
      let done!: () => void;
      const verified = new Promise<void>((r) => (done = r));
      const sender = new TransferSender(files, CHUNK, createInlineHasher, {
        onAccepted: () => {},
        onProgress: () => {},
        onFinalizing: () => {},
        onVerified: () => done(),
        onRejected: () => {},
        onCancelled: () => {},
        onFailed: () => {},
      });
      const linkS = new DataChannelLink(ch.a, {
        onControl: (m) => sender.handleControl(m),
        onBinary: () => {},
        onClose: () => sender.detach(),
      });
      sender.attach(linkS);
      await verified;
      await wait(20);
    };

    const a = [rand(150_000)];
    const b = [rand(260_000), rand(5)];
    await runBatch(a);
    await runBatch(b);

    expect(offers).toHaveLength(2);
    expect(offers[0]).not.toBe(offers[1]);
    expect(received).toHaveLength(2);
    expect((await bytesOf(received[0][0].file!)).equals(await bytesOf(a[0]))).toBe(true);
    expect(received[1]).toHaveLength(2);
    for (let i = 0; i < b.length; i++) {
      expect((await bytesOf(received[1][i].file!)).equals(await bytesOf(b[i]))).toBe(true);
    }
  });
});

describe("peer-to-peer transfer engine (loopback)", () => {
  it("delivers every file byte-for-byte, verified, with names and types intact", async () => {
    const files = [rand(300_000), new File([], "empty.heic", { type: "image/heic" }), rand(1_500_017), rand(1)];
    const r = rig(files);
    const ch = pair();
    r.connect(ch);
    expect(await r.result).toBe("verified");
    await wait(20);
    expect(r.events).toContain("complete");
    expect(r.received).toHaveLength(files.length);
    for (let i = 0; i < files.length; i++) {
      const got = r.received[i].file!;
      expect(got.name).toBe(files[i].name);
      expect(got.type).toBe("image/heic");
      expect(got.size).toBe(files[i].size);
      expect((await bytesOf(got)).equals(await bytesOf(files[i]))).toBe(true);
    }
  });

  it("respects backpressure: the send queue never runs away", async () => {
    const files = [rand(4_000_000)];
    const r = rig(files);
    const ch = pair(64 * 1024); // slow link
    r.connect(ch);
    expect(await r.result).toBe("verified");
    expect(ch.a.peak).toBeLessThanOrEqual(HIGH_WATER_MARK + CHUNK + 64 * 1024);
    expect(ch.a.peak).toBeGreaterThan(0);
  });

  it("does not move a single data frame until the receiver accepts", async () => {
    const r = rig([rand(200_000)], { autoAccept: false });
    const ch = pair();
    r.connect(ch);
    await wait(60);
    expect(r.events).toEqual(["offer"]);
    expect(ch.a.frames).toBe(0);
    r.receiver.accept();
    expect(await r.result).toBe("verified");
  });

  it("a declined transfer sends nothing", async () => {
    const r = rig([rand(100_000)], { autoAccept: false });
    const ch = pair();
    r.connect(ch);
    await wait(30);
    r.receiver.reject();
    expect(await r.result).toBe("rejected");
    expect(ch.a.frames).toBe(0);
  });

  it("never reports success for corrupted data", async () => {
    const files = [rand(400_000)];
    const r = rig(files);
    const ch = pair();
    ch.a.tamper = (n, buf) => {
      if (n === 4) new Uint8Array(buf)[100] ^= 0xff; // flip a payload bit in transit
      return buf;
    };
    r.connect(ch);
    expect(await r.result).toBe("failed");
    await wait(20);
    expect(r.events).not.toContain("complete");
    expect(r.events).toContain("receiver-failed:verification-failed");
    expect(r.received).toHaveLength(0);
  });

  it("rejects out-of-order or wrong-sized frames as a protocol error", async () => {
    const files = [rand(200_000)];
    const r = rig(files);
    const ch = pair();
    ch.a.tamper = (n, buf) => (n === 2 ? buf.slice(0, buf.byteLength - 10) : buf); // truncated payload
    r.connect(ch);
    await wait(150);
    expect(r.events).toContain("receiver-failed:protocol");
    expect(r.events).not.toContain("complete");
  });

  it("resumes from the receiver's last contiguous chunk after a disconnect", async () => {
    const files = [rand(3_000_000), rand(500_000)];
    const total = files.reduce((n, f) => n + f.size, 0);
    const r = rig(files);
    const first = pair(96 * 1024);
    r.connect(first);

    // cut the connection once roughly a third has arrived
    while (r.receiver.receivedBytes < total / 3) await wait(2);
    const before = r.receiver.receivedBytes;
    first.a.close();
    await wait(30);
    expect(r.events).not.toContain("complete");

    const second = pair();
    r.connect(second);
    expect(await r.result).toBe("verified");
    await wait(20);

    expect(r.events.some((e) => e.startsWith("resumed@"))).toBe(true);
    // the second channel must not have re-sent what the receiver already had
    const resentBytes = second.a.delivered;
    expect(resentBytes).toBeLessThan(total - before * 0.9);
    expect(r.received).toHaveLength(2);
    for (let i = 0; i < files.length; i++) {
      expect((await bytesOf(r.received[i].file!)).equals(await bytesOf(files[i]))).toBe(true);
    }
  });

  it("sanitizes hostile names from the peer", async () => {
    const evil = new File([new Uint8Array(randomBytes(100))], "../../Windows/System32/evil.exe", { type: "" });
    const r = rig([evil]);
    r.connect(pair());
    expect(await r.result).toBe("verified");
    await wait(20);
    expect(r.received[0].name).not.toMatch(/[\\/]/);
  });

  it("frames carry (fileIndex, chunkIndex) identity", async () => {
    const r = rig([rand(100_000)]);
    const ch = pair();
    const seen: Array<[number, number]> = [];
    ch.a.tamper = (_n, buf) => {
      const f = decodeFrame(buf)!;
      seen.push([f.fileIndex, f.chunkIndex]);
      return buf;
    };
    r.connect(ch);
    await r.result;
    expect(seen.map((s) => s[1])).toEqual([0, 1, 2, 3]);
    expect(new Set(seen.map((s) => s[0]))).toEqual(new Set([0]));
  });
});

describe("sliding window + ACK ranges", () => {
  it("keeps unconfirmed bytes bounded while many chunks stay in flight", async () => {
    const WINDOW = 1024 * 1024;
    const file = rand(6_000_000);
    let peakInFlight = 0;
    let acks = 0;
    let done!: () => void;
    const verified = new Promise<void>((r) => (done = r));
    const receiver = new TransferReceiver(createInlineHasher, {
      onOffer: () => receiver.accept(),
      onProgress: () => {},
      onFinalizing: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onFailed: () => done(),
    });
    const sender: TransferSender = new TransferSender(
      [file],
      CHUNK,
      createInlineHasher,
      {
        onAccepted: () => {},
        onProgress: () => {
          peakInFlight = Math.max(peakInFlight, sender.inFlightBytes);
        },
        onFinalizing: () => {},
        onVerified: () => done(),
        onRejected: () => done(),
        onCancelled: () => done(),
        onFailed: () => done(),
      },
      { window: WINDOW, highWater: 4 * 1024 * 1024, lowWater: 1024 * 1024, pollMs: 5 },
    );
    const ch = pair(256 * 1024);
    const origOnMsg = ch.a.addEventListener.bind(ch.a);
    ch.a.addEventListener = ((type: string, l: EventListenerOrEventListenerObject, o?: unknown) => {
      if (type === "message") {
        const wrapped = (e: Event) => {
          const d = (e as MessageEvent).data;
          if (typeof d === "string" && d.includes('"type":"ack"')) acks++;
          (l as EventListener)(e);
        };
        return origOnMsg(type, wrapped, o as boolean);
      }
      return origOnMsg(type, l, o as boolean);
    }) as typeof ch.a.addEventListener;
    const la = new DataChannelLink(ch.a, { onControl: (m) => sender.handleControl(m), onBinary: () => {}, onClose: () => sender.detach() });
    const lb = new DataChannelLink(ch.b, { onControl: (m) => receiver.handleControl(m), onBinary: (b) => receiver.handleBinary(b), onClose: () => receiver.detach() });
    receiver.attach(lb);
    sender.attach(la);
    await verified;
    await wait(20);
    expect(peakInFlight).toBeLessThanOrEqual(2 * 512 * 1024 + CHUNK * 2); // window is floored at 2 ACK intervals
    expect(peakInFlight).toBeGreaterThan(CHUNK * 4); // genuinely many chunks in flight, not stop-and-wait
    // ACKs are ranges every ~512 KB, nowhere near one per chunk
    expect(acks).toBeGreaterThan(5);
    expect(acks).toBeLessThan(6_000_000 / CHUNK / 4);
    expect(WINDOW).toBeGreaterThan(0);
  });
});

describe("synthetic benchmark", () => {
  it("measures bytes through the same link and confirms them from the receiver", async () => {
    const ch = pair();
    const runner = new BenchRunner();
    const linkB: DataChannelLink = new DataChannelLink(ch.b, {
      onControl: (m) => void responder.handleControl(m),
      onBinary: (b) => (isBenchFrame(b) ? responder.handleFrame(b) : undefined),
      onClose: () => {},
    });
    const responder = new BenchResponder(() => linkB);
    const linkA = new DataChannelLink(ch.a, { onControl: (m) => void runner.handleControl(m), onBinary: () => {}, onClose: () => {} });
    const r = await runner.run(linkA, { chunkSize: 64 * 1024, highWater: 1024 * 1024, lowWater: 256 * 1024, pollMs: 5 }, 8 * 1024 * 1024);
    expect(r.bytes).toBe(8 * 1024 * 1024);
    expect(r.mbPerSec).toBeGreaterThan(0);
    expect(r.peakBuffered).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024 + 8);
  });
});

describe("tuning", () => {
  it("clamps chunk to the SCTP message limit and buffers under Chrome's queue cap", () => {
    const t = resolveTuning({ maxMessageSize: 262144, search: "?chunk=256&high=32&low=8" });
    expect(t.chunkSize + FRAME_HEADER_BYTES).toBeLessThanOrEqual(262144);
    expect(t.highWater).toBeLessThanOrEqual(MAX_HIGH_WATER);
    expect(t.lowWater).toBeLessThan(t.highWater);
  });
  it("reads URL overrides and allows disabling the window", () => {
    const t = resolveTuning({ search: "?chunk=128&window=0&poll=200" });
    expect(t.chunkSize).toBe(128 * 1024);
    expect(t.window).toBe(0);
    expect(t.pollMs).toBe(200);
  });
});

describe("path stats parser", () => {
  const reports = [
    { id: "T", type: "transport", selectedCandidatePairId: "P" },
    { id: "P", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R", currentRoundTripTime: 0.021, availableOutgoingBitrate: 187_000_000, bytesSent: 10, bytesReceived: 20 },
    { id: "L", type: "local-candidate", candidateType: "host", protocol: "udp" },
    { id: "R", type: "remote-candidate", candidateType: "srflx" },
    { id: "D", type: "data-channel", messagesSent: 5, messagesReceived: 7 },
  ];
  it("reports host/udp as direct with RTT and capacity", () => {
    const s = parsePathStats(reports, "connected");
    expect(s.route).toBe("direct");
    expect(s.localType).toBe("host");
    expect(s.protocol).toBe("udp");
    expect(Math.round(s.rttMs!)).toBe(21);
    expect(Math.round(s.availableOutKbps!)).toBe(187000);
    expect(s.dcMessagesSent).toBe(5);
  });
  it("never calls a relay path direct", () => {
    const relay = reports.map((r) => (r.id === "L" ? { ...r, candidateType: "relay", protocol: "tcp" } : r));
    const s = parsePathStats(relay, "connected");
    expect(s.route).toBe("relayed");
    expect(s.protocol).toBe("tcp");
  });
  it("is honest when there is no selected pair yet", () => {
    expect(parsePathStats([], "new").route).toBe("unknown");
  });
});
