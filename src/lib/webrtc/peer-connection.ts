import { inspectRoute, type RouteInfo } from "./ice";
import type { SignalKind } from "./signaling-client";

export type PcState = "connecting" | "connected" | "disconnected" | "failed" | "closed";

export interface PeerOptions {
  /** The sender offers and owns the DataChannel; the receiver answers. */
  role: "offerer" | "answerer";
  iceServers: RTCIceServer[];
  signal(kind: SignalKind, data: unknown): void;
  onChannel(ch: RTCDataChannel): void;
  onState(s: PcState): void;
  onRoute(r: RouteInfo | null): void;
  /** Candidate gathering for the current generation finished; reports what this side offered. */
  onGathered?(local: CandidateTally): void;
}

interface Envelope {
  gen: number;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

/** Candidate counts by type ("host", "srflx", "prflx", "relay") for one generation. */
export type CandidateTally = Record<string, number>;

const candidateType = (line: string | undefined) => / typ (\w+)/.exec(line ?? "")?.[1] ?? "unknown";

function tallySdp(t: CandidateTally, sdp: string | undefined) {
  for (const line of (sdp ?? "").split(/\r?\n/)) {
    if (line.startsWith("a=candidate:")) t[candidateType(line)] = (t[candidateType(line)] ?? 0) + 1;
  }
}

export interface PeerDiag {
  iceState: string;
  signalingState: string;
  channelState: string;
  generation: number;
  route: RouteInfo | null;
}

/**
 * Owns the RTCPeerConnection. A "generation" is one connection attempt: ICE
 * restarts reuse it (the DataChannel survives), a new generation rebuilds
 * everything. Pure WebRTC — no UI and no transfer logic in here.
 */
export class PeerConnectionManager {
  private pc: RTCPeerConnection | null = null;
  private gen = 0;
  private remoteSet = false;
  private pendingIce: Array<{ gen: number; init: RTCIceCandidateInit }> = [];
  private channel: RTCDataChannel | null = null;
  private route: RouteInfo | null = null;
  private closed = false;
  private localTally: CandidateTally = {};
  private gatherTimer: ReturnType<typeof setTimeout> | null = null;
  /** Keyed by generation: the answerer can hear candidates before the offer that opens their generation. */
  private remoteTally = new Map<number, CandidateTally>();

  constructor(private o: PeerOptions) {}

  get generation() {
    return this.gen;
  }

  diag(): PeerDiag {
    return {
      iceState: this.pc?.iceConnectionState ?? "none",
      signalingState: this.pc?.signalingState ?? "none",
      channelState: this.channel?.readyState ?? "none",
      generation: this.gen,
      route: this.route,
    };
  }

  /** What each side offered this attempt: tells "browser hides its address" apart from "network blocks the path". */
  candidates(): { local: CandidateTally; remote: CandidateTally } {
    return { local: { ...this.localTally }, remote: { ...this.remoteFor(this.gen) } };
  }

  private remoteFor(gen: number): CandidateTally {
    let t = this.remoteTally.get(gen);
    if (!t) this.remoteTally.set(gen, (t = {}));
    return t;
  }

  get peerConnection() {
    return this.pc;
  }

  /** Offerer: begin a brand-new connection attempt. */
  async start() {
    this.gen++;
    this.build();
    const ch = this.pc!.createDataChannel("origin-transfer", { ordered: true });
    this.adopt(ch);
    await this.negotiate(false);
  }

  /** Offerer: re-gather candidates on the same connection (network change, brief drop). */
  async restartIce() {
    if (!this.pc || this.o.role !== "offerer" || this.pc.signalingState !== "stable") return;
    await this.negotiate(true);
  }

  async handleSignal(kind: SignalKind, raw: unknown) {
    if (this.closed) return;
    const env = raw as Envelope;
    if (!env || typeof env.gen !== "number") return;
    try {
      if (kind === "offer" && this.o.role === "answerer" && env.sdp) {
        if (env.gen > this.gen || !this.pc) {
          this.gen = env.gen;
          this.build();
          this.pc!.ondatachannel = (e) => this.adopt(e.channel);
        } else if (env.gen < this.gen) return;
        await this.pc!.setRemoteDescription(env.sdp);
        tallySdp(this.remoteFor(env.gen), env.sdp.sdp);
        this.remoteSet = true;
        await this.flushIce();
        await this.pc!.setLocalDescription(await this.pc!.createAnswer());
        this.o.signal("answer", { gen: this.gen, sdp: this.pc!.localDescription!.toJSON() } satisfies Envelope);
      } else if (kind === "answer" && this.o.role === "offerer" && env.sdp && env.gen === this.gen) {
        await this.pc?.setRemoteDescription(env.sdp);
        tallySdp(this.remoteFor(env.gen), env.sdp.sdp);
        this.remoteSet = true;
        await this.flushIce();
      } else if (kind === "ice" && env.candidate) {
        if (env.gen >= this.gen && env.candidate.candidate) {
          const tally = this.remoteFor(env.gen);
          const t = candidateType(env.candidate.candidate);
          tally[t] = (tally[t] ?? 0) + 1;
        }
        this.pendingIce.push({ gen: env.gen, init: env.candidate });
        if (this.remoteSet && env.gen === this.gen) await this.flushIce();
      }
    } catch {
      this.o.onState("failed");
    }
  }

  close() {
    this.closed = true;
    this.teardown();
    this.o.onState("closed");
  }

  /** Close the current attempt but keep the manager usable for a new generation. */
  private teardown() {
    const pc = this.pc;
    this.pc = null;
    if (this.gatherTimer) clearTimeout(this.gatherTimer);
    this.gatherTimer = null;
    this.channel = null;
    this.remoteSet = false;
    if (pc) {
      pc.onicecandidate = pc.oniceconnectionstatechange = pc.ondatachannel = null;
      try {
        pc.close();
      } catch {
        /* already closed */
      }
    }
  }

  private build() {
    this.teardown();
    this.route = null;
    this.localTally = {};
    // Report once per generation: when gathering completes, or after 3 s (an unreachable STUN server can stall it).
    let reported = false;
    const report = () => {
      if (reported || pc !== this.pc) return;
      reported = true;
      this.o.onGathered?.({ ...this.localTally });
    };
    for (const g of this.remoteTally.keys()) if (g < this.gen) this.remoteTally.delete(g);
    const gen = this.gen;
    const pc = new RTCPeerConnection({ iceServers: this.o.iceServers, bundlePolicy: "max-bundle" });
    this.pc = pc;
    this.gatherTimer = setTimeout(report, 3000);
    pc.onicecandidate = (e) => {
      if (e.candidate?.candidate) {
        const t = candidateType(e.candidate.candidate);
        this.localTally[t] = (this.localTally[t] ?? 0) + 1;
      }
      if (!e.candidate && pc === this.pc) report();
      if (e.candidate) this.o.signal("ice", { gen, candidate: e.candidate.toJSON() } satisfies Envelope);
    };
    pc.oniceconnectionstatechange = () => {
      if (pc !== this.pc) return;
      switch (pc.iceConnectionState) {
        case "checking":
        case "new":
          this.o.onState("connecting");
          break;
        case "connected":
        case "completed":
          this.o.onState("connected");
          void inspectRoute(pc)
            .then((r) => {
              if (pc !== this.pc) return;
              this.route = r;
              this.o.onRoute(r);
            })
            .catch(() => {});
          break;
        case "disconnected":
          this.o.onState("disconnected");
          break;
        case "failed":
          this.o.onState("failed");
          break;
        case "closed":
          this.o.onState("closed");
          break;
      }
    };
  }

  private adopt(ch: RTCDataChannel) {
    this.channel = ch;
    this.o.onChannel(ch);
  }

  private async negotiate(iceRestart: boolean) {
    const pc = this.pc!;
    const offer = await pc.createOffer({ iceRestart });
    await pc.setLocalDescription(offer);
    this.o.signal("offer", { gen: this.gen, sdp: pc.localDescription!.toJSON() } satisfies Envelope);
  }

  private async flushIce() {
    const ready = this.pendingIce.filter((c) => c.gen === this.gen);
    this.pendingIce = this.pendingIce.filter((c) => c.gen > this.gen);
    for (const c of ready) {
      try {
        await this.pc?.addIceCandidate(c.init);
      } catch {
        /* stale candidate */
      }
    }
  }
}
