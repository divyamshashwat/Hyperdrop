import type { CandidateType } from "../webrtc/ice";

/** A point-in-time view of the network path, from RTCPeerConnection.getStats(). */
export interface PathStats {
  iceState: string;
  localType: CandidateType;
  remoteType: CandidateType;
  protocol: string;
  route: "direct" | "relayed" | "unknown";
  rttMs: number | null;
  /** The congestion controller's estimate. Often absent for DataChannel-only connections. */
  availableOutKbps: number | null;
  bytesSent: number;
  bytesReceived: number;
  packetsLost: number | null;
  dcMessagesSent: number;
  dcMessagesReceived: number;
  sampledAt: number;
}

export const EMPTY_PATH: PathStats = {
  iceState: "none",
  localType: "unknown",
  remoteType: "unknown",
  protocol: "",
  route: "unknown",
  rttMs: null,
  availableOutKbps: null,
  bytesSent: 0,
  bytesReceived: 0,
  packetsLost: null,
  dcMessagesSent: 0,
  dcMessagesReceived: 0,
  sampledAt: 0,
};

type Report = Record<string, unknown>;

/** Pure parser so it can be unit-tested with canned stats. */
export function parsePathStats(reports: Report[], iceState: string, now = Date.now()): PathStats {
  const byId = new Map<string, Report>();
  for (const r of reports) byId.set(String(r.id), r);

  let pair: Report | undefined;
  for (const r of reports) {
    if (r.type === "transport" && r.selectedCandidatePairId) pair = byId.get(String(r.selectedCandidatePairId));
  }
  if (!pair) pair = reports.find((r) => r.type === "candidate-pair" && r.state === "succeeded" && (r.nominated || r.selected));

  const cand = (id: unknown) => byId.get(String(id));
  const local = pair ? cand(pair.localCandidateId) : undefined;
  const remote = pair ? cand(pair.remoteCandidateId) : undefined;
  const localType = (local?.candidateType as CandidateType) ?? "unknown";
  const remoteType = (remote?.candidateType as CandidateType) ?? "unknown";

  const dc = reports.filter((r) => r.type === "data-channel");
  const sum = (k: string) => dc.reduce((n, r) => n + (Number(r[k]) || 0), 0);
  const lost = reports.filter((r) => r.type === "remote-inbound-rtp" || r.type === "inbound-rtp");

  return {
    iceState,
    localType,
    remoteType,
    protocol: String(local?.protocol ?? ""),
    route: !pair ? "unknown" : localType === "relay" || remoteType === "relay" ? "relayed" : "direct",
    rttMs: pair && typeof pair.currentRoundTripTime === "number" ? pair.currentRoundTripTime * 1000 : null,
    availableOutKbps: pair && typeof pair.availableOutgoingBitrate === "number" ? pair.availableOutgoingBitrate / 1000 : null,
    bytesSent: Number(pair?.bytesSent) || 0,
    bytesReceived: Number(pair?.bytesReceived) || 0,
    packetsLost: lost.length ? lost.reduce((n, r) => n + (Number(r.packetsLost) || 0), 0) : null,
    dcMessagesSent: sum("messagesSent"),
    dcMessagesReceived: sum("messagesReceived"),
    sampledAt: now,
  };
}

export async function samplePath(pc: RTCPeerConnection): Promise<PathStats> {
  const reports: Report[] = [];
  (await pc.getStats()).forEach((r) => reports.push(r));
  return parsePathStats(reports, pc.iceConnectionState);
}

/**
 * Event-loop lag: how late a 100 ms timer fires. Sustained lag during a transfer
 * means the main thread (not the network) is the bottleneck.
 */
export function startLagMonitor(): { read(): number; stop(): void } {
  let ema = 0;
  let last = performance.now();
  const t = setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - last - 100);
    ema = ema * 0.8 + lag * 0.2;
    last = now;
  }, 100);
  return { read: () => ema, stop: () => clearInterval(t) };
}

/** Chrome-only. Safari/Firefox don't expose JS heap size. */
export function jsHeapBytes(): number | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? m.usedJSHeapSize : null;
}

export type NetworkClass = "excellent" | "good" | "fair" | "poor";

/** Internal classification only; never shown as fake precision. */
export function classifyThroughput(bytesPerSecond: number): NetworkClass {
  const mbps = (bytesPerSecond * 8) / 1e6;
  return mbps >= 200 ? "excellent" : mbps >= 80 ? "good" : mbps >= 30 ? "fair" : "poor";
}
