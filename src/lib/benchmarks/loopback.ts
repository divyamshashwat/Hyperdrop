import { createWorkerHasher } from "../webrtc/checksum";
import { DataChannelLink } from "../webrtc/data-channel";
import { TransferReceiver, TransferSender } from "../webrtc/transfer-manager";
import { BenchResponder, BenchRunner, type BenchResult } from "./synthetic";
import { isBenchFrame } from "../webrtc/protocol";
import { resolveTuning, type Tuning } from "../webrtc/tuning";

/**
 * Two RTCPeerConnections inside one page, wired directly (no signaling server,
 * no STUN). It measures our application pipeline over a real browser WebRTC
 * stack without the radio in the way. It is NOT a substitute for a phone-to-PC
 * run, but it tells you whether the app itself can go fast.
 */
export interface Loopback {
  a: RTCDataChannel;
  b: RTCDataChannel;
  maxMessageSize: number;
  close(): void;
}

const gathered = (pc: RTCPeerConnection) =>
  new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && resolve());
  });

const opened = (ch: RTCDataChannel) =>
  new Promise<void>((resolve) => (ch.readyState === "open" ? resolve() : ch.addEventListener("open", () => resolve(), { once: true })));

export async function createLoopback(): Promise<Loopback> {
  const pa = new RTCPeerConnection();
  const pb = new RTCPeerConnection();
  const a = pa.createDataChannel("bench", { ordered: true });
  const bReady = new Promise<RTCDataChannel>((res) => (pb.ondatachannel = (e) => res(e.channel)));
  await pa.setLocalDescription(await pa.createOffer());
  await gathered(pa);
  await pb.setRemoteDescription(pa.localDescription!);
  await pb.setLocalDescription(await pb.createAnswer());
  await gathered(pb);
  await pa.setRemoteDescription(pb.localDescription!);
  const b = await bReady;
  await Promise.all([opened(a), opened(b)]);
  return {
    a,
    b,
    maxMessageSize: pa.sctp?.maxMessageSize ?? 262144,
    close: () => {
      pa.close();
      pb.close();
    },
  };
}

export interface MatrixRow {
  name: string;
  tuning: Tuning;
  synthetic: BenchResult;
  fileMBps: number;
  fileMs: number;
}

function randomFile(bytes: number): File {
  const parts: Uint8Array[] = [];
  for (let o = 0; o < bytes; o += 1 << 20) {
    const p = new Uint8Array(Math.min(1 << 20, bytes - o));
    for (let k = 0; k < p.length; k += 65536) crypto.getRandomValues(p.subarray(k, Math.min(p.length, k + 65536)));
    parts.push(p);
  }
  return new File(parts as BlobPart[], "IMG_BENCH.HEIC", { type: "image/heic" });
}

/** One configuration: synthetic benchmark, then a real hashed file transfer, on a fresh connection. */
export async function runConfig(name: string, requested: Tuning, megabytes: number): Promise<MatrixRow> {
  const lb = await createLoopback();
  // Same clamp the real session applies: payload + 8-byte header must fit one SCTP message.
  const tuning = resolveTuning({ maxMessageSize: lb.maxMessageSize, base: requested });
  try {
    const runner = new BenchRunner();
    const responder = new BenchResponder(() => linkB);
    let sender: TransferSender | null = null;
    let receiver: TransferReceiver | null = null;
    const linkA: DataChannelLink = new DataChannelLink(lb.a, {
      onControl: (m) => void (runner.handleControl(m) || sender?.handleControl(m)),
      onBinary: () => {},
      onClose: () => {},
    });
    const linkB: DataChannelLink = new DataChannelLink(lb.b, {
      onControl: (m) => void (responder.handleControl(m) || receiver?.handleControl(m)),
      onBinary: (buf) => (isBenchFrame(buf) ? responder.handleFrame(buf) : receiver?.handleBinary(buf)),
      onClose: () => {},
    });

    const bytes = megabytes * 1024 * 1024;
    const synthetic = await runner.run(linkA, tuning, bytes);

    const file = randomFile(bytes);
    let done!: () => void;
    const verified = new Promise<void>((r) => (done = r));
    receiver = new TransferReceiver(createWorkerHasher, {
      onOffer: () => receiver!.accept(),
      onProgress: () => {},
      onFinalizing: () => {},
      onComplete: () => {},
      onCancelled: () => {},
      onFailed: () => done(),
    });
    sender = new TransferSender(
      [file],
      tuning.chunkSize,
      createWorkerHasher,
      {
        onAccepted: () => {},
        onProgress: () => {},
        onFinalizing: () => {},
        onVerified: () => done(),
        onRejected: () => done(),
        onCancelled: () => done(),
        onFailed: () => done(),
      },
      tuning,
    );
    receiver.attach(linkB);
    const t0 = performance.now();
    sender.attach(linkA);
    await verified;
    const fileMs = performance.now() - t0;
    return { name, tuning, synthetic, fileMBps: bytes / 1e6 / (fileMs / 1000), fileMs };
  } finally {
    lb.close();
  }
}

export async function runMatrix(
  configs: Array<{ name: string; tuning: Tuning }>,
  megabytes: number,
  onRow?: (row: MatrixRow) => void,
): Promise<MatrixRow[]> {
  const rows: MatrixRow[] = [];
  for (const c of configs) {
    try {
      const row = await runConfig(c.name, c.tuning, megabytes);
      rows.push(row);
      onRow?.(row);
    } catch (e) {
      // One bad configuration must not hide the others.
      console.warn(`[bench] ${c.name} failed:`, e);
    }
  }
  return rows;
}
