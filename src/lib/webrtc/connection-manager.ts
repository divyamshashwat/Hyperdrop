import { MemorySink, type FileSink, type ReceivedFile } from "../files/sink";
import { detectDevice, type DeviceInfo } from "../session/device";
import { buildJoinLink } from "../session/room";
import { createSession, joinSession, SessionApiError } from "../session/session";
import { EMPTY_METRICS, RollingMeter, percentage, type MetricsSnapshot } from "../transfer/metrics";
import { BenchResponder, BenchRunner, type BenchResult } from "../benchmarks/synthetic";
import { EMPTY_PATH, jsHeapBytes, samplePath, startLagMonitor, type PathStats } from "../diagnostics/stats";
import { createWorkerHasher } from "./checksum";
import { DEFAULT_TUNING, resolveTuning, type Tuning } from "./tuning";
import type { Action, ConnectHint, ErrorCode, Summary } from "./connection-state";
import { DataChannelLink } from "./data-channel";
import { loadIceConfig, type IceConfig, type RouteInfo } from "./ice";
import { PeerConnectionManager, type CandidateTally, type PcState } from "./peer-connection";
import { PROTOCOL_VERSION, isBenchFrame } from "./protocol";
import { SignalingClient } from "./signaling-client";
import { TransferReceiver, TransferSender, type Manifest, type Progress } from "./transfer-manager";

export interface SessionEvents {
  dispatch(a: Action): void;
  /** Throttled (~8 Hz). */
  onMetrics(m: MetricsSnapshot): void;
  onReceived(files: ReceivedFile[]): void;
  onDiag?(d: DiagSnapshot): void;
}

export interface DiagSnapshot {
  platform: string;
  signaling: string;
  iceState: string;
  signalingState: string;
  channelState: string;
  candidates: string;
  bufferedAmount: number;
  bytesPerSecond: number;
  bytesSent: number;
  bytesReceived: number;
  reconnects: number;
  hash: string;
  chunkSize: number;
  policy: string;
  /** Network path from getStats(): ICE type, protocol, RTT, capacity. */
  path: PathStats;
  tuning: Tuning;
  /** Sender only: unconfirmed bytes currently in flight. */
  inFlight: number;
  /** Main-thread timer lag (ms). Sustained > ~50 means the CPU, not the network, is limiting. */
  loopLagMs: number;
  heapBytes: number | null;
  currentFile: string | null;
  lastBench: BenchResult | null;
}

const CONNECT_TIMEOUT_MS = 25_000;
/** The receiver also waits out a phone asking its user for the one-tap local-network unlock. */
const RECEIVER_CONNECT_TIMEOUT_MS = 45_000;
const LOSS_WINDOW_MS = 30_000;
const EMIT_MS = 125;
const POST_COMPLETE_MS = 5 * 60_000;

/**
 * One transfer session. Owns signaling, the peer connection and the transfer
 * engines, and reports everything to the UI as reducer actions + throttled metrics.
 */
export class TransferSession {
  private device: DeviceInfo = detectDevice();
  private ice: IceConfig | null = null;
  private signaling: SignalingClient | null = null;
  private peer: PeerConnectionManager | null = null;
  private channel: RTCDataChannel | null = null;
  private link: DataChannelLink | null = null;
  private sender: TransferSender | null = null;
  private receiver: TransferReceiver | null = null;
  private peerLabel = "Device";
  private route: RouteInfo | null = null;

  private everOpened = false;
  private finished = false;
  private disposed = false;
  private restarts = 0;
  private reconnects = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private lossTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lossAt = 0;
  private postTimer: ReturnType<typeof setTimeout> | null = null;
  private hostAuth: { roomId: string; token: string } | null = null;
  private streamLost = false;
  private startedOnce = false;
  private chunkSize = 0;
  private hashNote = "—";
  private tuning: Tuning = DEFAULT_TUNING;
  private runner = new BenchRunner();
  private responder = new BenchResponder(() => this.link);
  private path: PathStats = EMPTY_PATH;
  private lag: ReturnType<typeof startLagMonitor> | null = null;
  private lastBench: BenchResult | null = null;
  private statsBusy = false;
  /** Held only while connecting: Safari shares its local address only with pages that have microphone access. */
  private lanStream: MediaStream | null = null;
  private lanTried = false;
  /** Between "no local address" and the retry that follows the tap. */
  private lanWaiting = false;
  /** What actually arrived over signaling, for the failure details: "no answer" and "answer but no ICE" differ. */
  private sigIn: Record<string, number> = {};
  private sigStream = "none";
  private sigReady = 0;

  private meter = new RollingMeter();
  private latest: Progress | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private diagTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly role: "sender" | "receiver",
    private ev: SessionEvents,
  ) {}

  /* ------------------------------------------------------------- bootstrap */

  /** Receiver: open a temporary room and wait for the sender. */
  async startReceiving() {
    this.ev.dispatch({ type: "RECEIVE_START" });
    this.receiver = this.makeReceiver();
    try {
      const [ice, created] = await Promise.all([loadIceConfig(), createSession(this.device.label)]);
      this.ice = ice;
      const origin = process.env.NEXT_PUBLIC_APP_ORIGIN || window.location.origin;
      this.peer = this.makePeer("answerer");
      this.signaling = new SignalingClient(created.roomId, created.hostToken, this.signalingHandlers());
      this.signaling.connect();
      this.hostAuth = { roomId: created.roomId, token: created.hostToken };
      this.ev.dispatch({
        type: "SESSION_READY",
        pairing: {
          roomId: created.roomId,
          code: created.code,
          link: buildJoinLink(origin, created.roomId, created.joinSecret),
          expiresAt: created.expiresAt,
        },
      });
    } catch (e) {
      this.failApi(e);
    }
  }

  /**
   * Receiver: get a fresh single-use token to broadcast over Nearby. Same room;
   * a new call revokes the previous token.
   */
  async issueNearbyToken(): Promise<string | null> {
    if (!this.hostAuth) return null;
    try {
      const res = await fetch(`/api/session/${this.hostAuth.roomId}/nearby`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.hostAuth.token}` },
        cache: "no-store",
      });
      if (!res.ok) return null;
      return ((await res.json()) as { token: string }).token;
    } catch {
      return null;
    }
  }

  /**
   * Sender: join the receiver's room with the QR secret, the numeric code, or a
   * token heard over Nearby. With `quiet`, a rejected token is simply reported
   * back (Nearby keeps listening) instead of putting the app into a failed state.
   */
  async join(
    by: { roomId: string; secret: string } | { code: string } | { nearby: string },
    linked = false,
    opts: { quiet?: boolean } = {},
  ): Promise<boolean> {
    if (!opts.quiet) this.ev.dispatch({ type: "PAIRING", linked });
    try {
      const [ice, joined] = await Promise.all([loadIceConfig(), joinSession(by, this.device.label)]);
      if (opts.quiet) this.ev.dispatch({ type: "PAIRING", linked });
      this.ice = ice;
      this.peerLabel = joined.peer;
      this.peer = this.makePeer("offerer");
      this.signaling = new SignalingClient(joined.roomId, joined.guestToken, this.signalingHandlers());
      this.signaling.connect();
      this.ev.dispatch({ type: "CONNECTING", label: joined.peer });
      this.armConnectTimeout();
      await this.peer.start();
      return true;
    } catch (e) {
      if (opts.quiet && e instanceof SessionApiError && (e.reason === "not-found" || e.reason === "rate-limited")) return false;
      this.failApi(e);
      return false;
    }
  }

  private failApi(e: unknown) {
    const reason = e instanceof SessionApiError ? e.reason : "server";
    const code: ErrorCode =
      reason === "not-found" || reason === "forbidden"
        ? "session-not-found"
        : reason === "occupied"
          ? "session-busy"
          : reason === "rate-limited"
            ? "rate-limited"
            : "connection-failed";
    this.ev.dispatch({ type: "FAILED", code, detail: reason });
  }

  /* ------------------------------------------------------- user intentions */

  sendFiles(files: File[]) {
    if (!this.link || !this.channel || this.sender) return;
    this.tuning = this.resolveTuning();
    this.chunkSize = this.tuning.chunkSize;
    const totalBytes = files.reduce((n, f) => n + f.size, 0);
    this.meter = new RollingMeter();
    this.sender = new TransferSender(files, this.chunkSize, createWorkerHasher, {
      onAccepted: (resumed, isResume) => {
        this.meter.resetWindow(resumed);
        if (!isResume || !this.startedOnce) {
          this.startedOnce = true;
          this.ev.dispatch({ type: "TRANSFER_STARTED" });
        } else {
          this.ev.dispatch({
            type: "TRANSFER_STARTED",
            resumedFrom: Math.round(percentage(resumed, totalBytes)),
          });
        }
      },
      onProgress: (p) => this.progress(p),
      onFinalizing: () => {
        this.flushMetrics();
        this.ev.dispatch({ type: "FINALIZING" });
      },
      onVerified: () => {
        this.hashNote = "verified by receiver";
        this.complete();
      },
      onRejected: () => this.fail("rejected"),
      onCancelled: () => this.peerCancelled(),
      onFailed: (reason) => this.fail(reason === "read-error" ? "permission" : "verification-failed"),
    }, this.tuning);
    this.sender.attach(this.link);
    this.ev.dispatch({ type: "OFFER_SENT", summary: summarize(files.map((f) => ({ name: f.name, size: f.size }))) });
  }

  /** Receiver: the user accepted. `sink` lets Chromium stream into a chosen folder. */
  accept(sink?: (files: ConstructorParameters<typeof MemorySink>[0]) => FileSink) {
    if (!this.receiver) return;
    this.meter = new RollingMeter();
    this.receiver.accept(sink);
    this.startedOnce = true;
    this.ev.dispatch({ type: "TRANSFER_STARTED" });
  }

  reject() {
    this.receiver?.reject();
    this.ev.dispatch({ type: "CANCELLED" });
    this.shutdownSoon();
  }

  cancel() {
    if (this.finished) return;
    this.finished = true;
    this.sender?.cancel();
    this.receiver?.cancel();
    this.ev.dispatch({ type: "CANCELLED" });
    this.shutdownSoon();
  }

  /** Sender: the user tapped Resume after an interruption. */
  resume() {
    if (this.role !== "sender" || this.finished) return;
    this.ev.dispatch({ type: "RESUMED" });
    this.restarts = 0;
    this.lossAt = 0;
    this.markLoss();
    void this.peer?.start();
  }

  /** The tab became visible / the network came back: stop waiting and recover now. */
  nudge() {
    if (this.finished || !this.everOpened) return;
    if (this.channel?.readyState === "open") return;
    if (this.role === "sender") this.recover();
  }

  /** Called on unmount / pagehide. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.finished = true;
    this.clearTimers();
    if (this.diagTimer) clearInterval(this.diagTimer);
    this.lag?.stop();
    this.sender?.detach();
    this.receiver?.detach();
    this.releaseLan();
    this.peer?.close();
    this.signaling?.leave();
  }

  private resolveTuning(): Tuning {
    return resolveTuning({
      maxMessageSize: this.peer?.peerConnection?.sctp?.maxMessageSize,
      search: typeof location === "undefined" ? "" : location.search,
    });
  }

  /**
   * Diagnostics: push synthetic bytes through the live DataChannel (no files)
   * to separate "the network path is the limit" from "the file pipeline is".
   */
  async runBenchmark(megabytes: number): Promise<BenchResult> {
    if (!this.link || this.channel?.readyState !== "open") throw new Error("not connected");
    if (this.sender && !this.finished) throw new Error("a transfer is in progress");
    const r = await this.runner.run(this.link, this.resolveTuning(), megabytes * 1024 * 1024);
    this.lastBench = r;
    return r;
  }

  /** The OS says the network is gone: tell the user the truth right away instead of showing "Sending". */
  onOffline() {
    if (this.finished || !this.everOpened) return;
    this.markLoss();
  }

  /** Diagnostics only: simulate an abrupt transport loss to exercise reconnect + resume. */
  debugDropChannel() {
    this.channel?.close();
  }

  startDiagnostics() {
    if (this.diagTimer || !this.ev.onDiag) return;
    this.lag = startLagMonitor();
    this.diagTimer = setInterval(() => {
      const pc = this.peer?.peerConnection;
      if (pc && !this.statsBusy) {
        this.statsBusy = true; // getStats at 1 Hz, never per frame
        samplePath(pc)
          .then((p) => (this.path = p))
          .catch(() => {})
          .finally(() => (this.statsBusy = false));
      }
      this.ev.onDiag?.(this.diag());
    }, 1000);
  }

  /* -------------------------------------------------------------- plumbing */

  private makeReceiver() {
    return new TransferReceiver(createWorkerHasher, {
      onOffer: (m: Manifest) => {
        if (this.postTimer) clearTimeout(this.postTimer); // a new batch on a finished session
        this.finished = false;
        this.startedOnce = false;
        this.meter = new RollingMeter();
        this.latest = null;
        this.ev.onReceived([]);
        this.ev.dispatch({
          type: "OFFER_RECEIVED",
          summary: summarize(m.files.map((f) => ({ name: f.name, size: f.size })), m.totalBytes),
        });
      },
      onProgress: (p) => this.progress(p),
      onFinalizing: () => {
        this.flushMetrics();
        this.ev.dispatch({ type: "FINALIZING" });
      },
      onComplete: (files) => {
        this.hashNote = `${files.length}/${files.length} files verified (SHA-256)`;
        this.ev.onReceived(files);
        this.complete();
      },
      onCancelled: () => this.peerCancelled(),
      onFailed: (reason) =>
        this.fail(reason === "storage" ? "storage" : reason === "protocol" ? "protocol" : "verification-failed"),
    });
  }

  /** Terminal failure: report it once, then close everything down. */
  private fail(code: ErrorCode) {
    if (this.disposed) return;
    this.finished = true;
    this.ev.dispatch({ type: "FAILED", code });
    this.shutdownSoon();
  }

  private makePeer(role: "offerer" | "answerer") {
    return new PeerConnectionManager({
      role,
      iceServers: this.ice!.iceServers,
      signal: (kind, data) => void this.signaling?.send(kind, data),
      onChannel: (ch) => this.bindChannel(ch),
      onState: (s) => this.onPcState(s),
      onRoute: (r) => this.onRoute(r),
      onGathered: (t) => this.onGathered(t),
    });
  }

  private signalingHandlers() {
    return {
      onReady: () => {
        this.sigReady++;
        this.streamLost = false;
      },
      onPeerJoined: (label: string) => {
        this.peerLabel = label;
        this.ev.dispatch({ type: "PEER_JOINED", label });
        this.armConnectTimeout();
      },
      onPeerLeft: () => {
        if (this.finished) return;
        if (this.channel?.readyState === "open") return; // the data path is still alive
        this.ev.dispatch({ type: "FAILED", code: "peer-left" });
        this.shutdownSoon();
      },
      onSignal: (kind: Parameters<PeerConnectionManager["handleSignal"]>[0], data: unknown) => {
        // A fresh offer is a fresh attempt (e.g. the phone just unlocked its local address): give it full time.
        this.sigIn[kind] = (this.sigIn[kind] ?? 0) + 1;
        if (kind === "offer" && this.role === "receiver" && !this.everOpened && !this.finished) this.armConnectTimeout();
        void this.peer?.handleSignal(kind, data);
      },
      onExpired: () => {
        if (this.finished) return;
        // A healthy peer-to-peer channel doesn't need the signaling room any more.
        if (this.channel?.readyState === "open" && (this.sender || this.receiver?.phase !== "idle")) return;
        this.finished = true;
        this.ev.dispatch(this.everOpened ? { type: "FAILED", code: "peer-left" } : { type: "EXPIRED" });
        this.shutdownSoon();
      },
      onStream: (s: "open" | "reconnecting" | "lost") => {
        this.sigStream = s;
        this.streamLost = s === "lost";
        if (s === "lost" && !this.everOpened && !this.finished) {
          this.ev.dispatch({ type: "FAILED", code: "connection-failed", detail: "signaling-lost" });
        }
      },
    };
  }

  private bindChannel(ch: RTCDataChannel) {
    const open = () => {
      if (this.disposed || this.finished) return;
      this.releaseLan(); // connected: the microphone was only needed to be found
      this.channel = ch;
      this.link = new DataChannelLink(ch, {
        onControl: (msg) => {
          if (msg.type === "hello") return;
          if (this.responder.handleControl(msg) || this.runner.handleControl(msg)) return;
          this.sender?.handleControl(msg);
          this.receiver?.handleControl(msg);
        },
        onBinary: (buf) => {
          if (isBenchFrame(buf)) this.responder.handleFrame(buf);
          else this.receiver?.handleBinary(buf);
        },
        onClose: () => {
          if (this.channel !== ch) return; // superseded by a newer generation
          this.link = null;
          this.sender?.detach();
          this.receiver?.detach();
          this.markLoss();
          // The channel can die while ICE stays healthy (SCTP reset): rebuild it with a new generation.
          if (this.role === "sender") {
            setTimeout(() => {
              if (this.finished || this.channel?.readyState === "open" || this.channel !== ch) return;
              this.restarts = 2;
              this.recover();
            }, 800);
          }
        },
      });
      this.link.sendControl({ type: "hello", v: PROTOCOL_VERSION, label: this.device.label });

      const wasReconnect = this.everOpened;
      this.everOpened = true;
      if (wasReconnect) this.reconnects++;
      this.clearLoss();
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.ev.dispatch({ type: "CONNECTED", label: this.peerLabel, route: this.route?.route ?? null });
      this.sender?.attach(this.link);
      this.receiver?.attach(this.link);
    };
    if (ch.readyState === "open") open();
    else ch.addEventListener("open", open, { once: true });
  }

  private onPcState(s: PcState) {
    if (this.finished) return;
    if (s === "failed") {
      if (!this.everOpened) {
        // The phone may be about to retry with its local address unlocked: let the connect timer decide.
        if (this.role === "receiver" || this.lanWaiting) return;
        this.failConnect("ice-failed");
        this.shutdownSoon();
        return;
      }
      this.markLoss();
      if (this.role === "sender") this.recover();
    } else if (s === "disconnected" && this.everOpened) {
      this.markLoss();
      if (this.role === "sender") {
        // Often self-heals within a moment (Wi-Fi roam); only restart if it doesn't.
        this.disconnectTimer = setTimeout(() => {
          if (this.peer?.peerConnection?.iceConnectionState !== "connected") this.recover();
        }, 3000);
      }
    }
  }

  private onRoute(r: RouteInfo | null) {
    this.route = r;
    if (!r) return;
    if (r.route === "relayed" && this.ice?.policy === "direct-only") {
      this.ev.dispatch({ type: "FAILED", code: "relay-blocked" });
      this.finished = true;
      this.shutdownSoon();
      return;
    }
    this.ev.dispatch({ type: "ROUTE", route: r.route });
  }

  /** Sender-side recovery ladder: ICE restart (twice), then a whole new connection. */
  private recover() {
    if (this.finished || !this.peer) return;
    if (this.restarts < 2) {
      this.restarts++;
      void this.peer.restartIce();
    } else {
      this.restarts = 0;
      void this.peer.start();
    }
  }

  private markLoss() {
    if (this.finished || !this.everOpened || this.lossAt) return;
    this.lossAt = Date.now();
    this.ev.dispatch({ type: "RECONNECTING" });
    this.lossTimer = setTimeout(() => this.giveUp(), LOSS_WINDOW_MS);
  }

  private clearLoss() {
    this.lossAt = 0;
    this.restarts = 0;
    if (this.lossTimer) clearTimeout(this.lossTimer);
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.lossTimer = this.disconnectTimer = null;
  }

  /** The window for automatic recovery elapsed. Keep partial progress; let the user decide. */
  private giveUp() {
    this.lossTimer = null;
    if (this.finished) return;
    const inFlight = this.sender || (this.receiver && this.receiver.phase === "receiving");
    if (inFlight) {
      this.lossAt = 0;
      this.ev.dispatch({ type: "PAUSED" });
    } else {
      this.finished = true;
      this.ev.dispatch({ type: "FAILED", code: "peer-left" });
      this.shutdownSoon();
    }
  }

  private armConnectTimeout() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.everOpened || this.finished) return;
      this.finished = true;
      this.failConnect("timeout");
      this.shutdownSoon();
    }, this.role === "receiver" ? RECEIVER_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS);
  }

  /**
   * Safari (iOS especially) hides its LAN address from WebRTC unless the page has microphone
   * access, so two devices on one Wi-Fi can't find each other. If gathering ended without a host
   * candidate, unlock it: silently when permission is already granted (e.g. after Nearby),
   * otherwise ask with one tap. The microphone is never read and is released once connected.
   */
  private onGathered(t: CandidateTally) {
    if (t.host || this.role !== "sender" || !this.device.webkit || this.lanTried || this.everOpened || this.finished) return;
    if (!navigator.mediaDevices?.getUserMedia) return;
    this.lanTried = true;
    this.lanWaiting = true;
    void micGranted().then((granted) => {
      if (this.finished || this.everOpened) return;
      if (granted) return void this.unlockLan();
      if (this.connectTimer) clearTimeout(this.connectTimer); // wait for the tap
      this.connectTimer = null;
      this.ev.dispatch({ type: "LAN_PROMPT", show: true });
    });
  }

  /** From the "Allow" tap (user activation), or automatically when permission is already granted. */
  async unlockLan() {
    if (this.finished || this.everOpened || !this.peer) return;
    this.ev.dispatch({ type: "LAN_PROMPT", show: false });
    this.lanWaiting = false;
    try {
      this.lanStream ??= await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.finished = true;
      this.failConnect("microphone-declined");
      this.shutdownSoon();
      return;
    }
    if (this.finished) return this.releaseLan();
    this.armConnectTimeout();
    void this.peer.start(); // new generation: re-gathers, now with host candidates
  }

  private releaseLan() {
    this.lanStream?.getTracks().forEach((t) => t.stop());
    this.lanStream = null;
  }

  /**
   * The direct path never opened. Say which side is the problem, from the candidates each offered:
   * no "host" candidate means that browser hides its LAN address (Brave, privacy extensions), so two
   * devices on one Wi-Fi can only meet through the router, which most routers don't allow.
   */
  private failConnect(reason: string) {
    const c = this.peer?.candidates() ?? { local: {}, remote: {} };
    const fmt = (t: Record<string, number>) =>
      Object.entries(t)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "none";
    const replied = this.sigIn[this.role === "sender" ? "answer" : "offer"];
    const hint: ConnectHint = !replied
      ? "no-reply"
      : !c.local.host
        ? "local-hidden"
        : !c.remote.host
          ? "remote-hidden"
          : "network";
    this.ev.dispatch({
      type: "FAILED",
      code: "connection-failed",
      detail:
        `${reason} · this device: ${fmt(c.local)} · other device: ${fmt(c.remote)}` +
        ` · signals in: ${fmt(this.sigIn)} · stream ${this.sigStream}, ready ${this.sigReady}` +
        ` · posts failed: ${this.signaling?.failedPosts ?? 0}`,
      hint,
    });
  }

  private clearTimers() {
    for (const t of [this.connectTimer, this.lossTimer, this.disconnectTimer, this.emitTimer, this.postTimer]) {
      if (t) clearTimeout(t);
    }
    this.connectTimer = this.lossTimer = this.disconnectTimer = this.emitTimer = this.postTimer = null;
  }

  private peerCancelled() {
    if (this.finished) return;
    this.finished = true;
    this.ev.dispatch({ type: "CANCELLED", byPeer: true });
    this.shutdownSoon();
  }

  private complete() {
    this.finished = true;
    this.flushMetrics();
    this.ev.dispatch({ type: "COMPLETED" });
    // Keep the session alive briefly so another batch needs no re-pairing, then let it expire.
    if (this.postTimer) clearTimeout(this.postTimer);
    this.postTimer = setTimeout(() => this.dispose(), POST_COMPLETE_MS);
  }

  /** Sender: reuse the live connection for another batch. False if the session is gone. */
  sendMore(): boolean {
    if (this.role !== "sender" || this.disposed || this.channel?.readyState !== "open") return false;
    if (this.postTimer) clearTimeout(this.postTimer);
    this.sender = null;
    this.finished = false;
    this.startedOnce = false;
    this.latest = null;
    this.meter = new RollingMeter();
    this.ev.dispatch({ type: "SEND_MORE" });
    return true;
  }

  /** Give in-flight control messages a moment to flush, then close everything. */
  private shutdownSoon(ms = 400) {
    setTimeout(() => this.dispose(), ms);
  }

  /* --------------------------------------------------------------- metrics */

  private progress(p: Progress) {
    this.latest = p;
    this.meter.record(p.bytes);
    this.emitTimer ??= setTimeout(() => {
      this.emitTimer = null;
      this.flushMetrics();
    }, EMIT_MS);
  }

  private flushMetrics() {
    const p = this.latest;
    if (!p) return;
    const r = this.meter.read(p.totalBytes);
    this.ev.onMetrics({
      ...EMPTY_METRICS,
      totalBytes: p.totalBytes,
      bytes: p.bytes,
      percentage: percentage(p.bytes, p.totalBytes),
      bytesPerSecond: r.bytesPerSecond,
      peakBytesPerSecond: r.peak,
      etaSeconds: r.etaSeconds,
      elapsedMs: r.elapsedMs,
      currentFile: p.currentName,
      currentFileBytes: p.currentBytes,
      currentFileSize: p.currentSize,
      fileCount: p.fileCount,
      filesDone: p.filesDone,
    });
  }

  private diag(): DiagSnapshot {
    const d = this.peer?.diag();
    const r = d?.route;
    return {
      platform: this.device.platform,
      signaling: this.streamLost ? "lost" : this.signaling ? "up" : "none",
      iceState: d?.iceState ?? "none",
      signalingState: d?.signalingState ?? "none",
      channelState: d?.channelState ?? "none",
      candidates: r ? `${r.local} → ${r.remote} (${r.protocol || "?"}) · ${r.route}` : "—",
      bufferedAmount: this.channel?.bufferedAmount ?? 0,
      bytesPerSecond: this.latest ? this.meter.read(this.latest.totalBytes).bytesPerSecond : 0,
      bytesSent: this.role === "sender" ? (this.latest?.bytes ?? 0) : 0,
      bytesReceived: this.role === "receiver" ? (this.latest?.bytes ?? 0) : 0,
      reconnects: this.reconnects,
      hash: this.hashNote,
      chunkSize: this.chunkSize,
      policy: this.ice?.policy ?? "—",
      path: this.path,
      tuning: this.tuning,
      inFlight: this.sender?.inFlightBytes ?? 0,
      loopLagMs: this.lag?.read() ?? 0,
      heapBytes: jsHeapBytes(),
      currentFile: this.latest?.currentName ?? null,
      lastBench: this.lastBench,
    };
  }
}

function summarize(files: Array<{ name: string; size: number }>, total?: number): Summary {
  return {
    fileCount: files.length,
    totalBytes: total ?? files.reduce((n, f) => n + f.size, 0),
    names: files.slice(0, 5).map((f) => f.name),
  };
}

async function micGranted(): Promise<boolean> {
  try {
    return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state === "granted";
  } catch {
    return false;
  }
}
