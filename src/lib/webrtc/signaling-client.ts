export type SignalKind = "offer" | "answer" | "ice" | "bye";

export interface SignalingHandlers {
  onReady(peer: string | null): void;
  onPeerJoined(label: string): void;
  onPeerLeft(): void;
  onSignal(kind: SignalKind, data: unknown): void;
  /** The room is gone (timed out, or the receiver left). */
  onExpired(): void;
  onStream(state: "open" | "reconnecting" | "lost"): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Consecutive failures (stream and poll both down) before signaling is reported lost. */
const MAX_POLL_FAILURES = 12;

/**
 * Signaling transport: ordered POSTs up; down, two paths at once. It only ever
 * carries SDP / ICE blobs. (Swappable for a WebSocket without touching callers.)
 *
 * The server numbers every message for this device. They arrive over a server-sent
 * event stream (fast) and over short polling (always works): a stream can stall
 * silently behind a proxy, as seen through a Cloudflare tunnel, where headers or
 * later events simply never arrive. Messages are handled once each, strictly in
 * number order, whichever path brings them first.
 */
export class SignalingClient {
  private closed = false;
  private terminal = false;
  private ctrl: AbortController | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Highest message number handled; anything at or below it is a duplicate. */
  private lastSeq = 0;
  /** Messages that arrived ahead of a gap, waiting for the missing number. */
  private held = new Map<number, { event: string; payload: Record<string, unknown> }>();
  private ready = false;
  private streamUp = false;
  private pollUp = false;
  /** Messages that never reached the server (diagnostics). */
  failedPosts = 0;
  /** How many messages came in over each path first (diagnostics). */
  via = { stream: 0, poll: 0 };
  /** Poll quickly while connecting; slowed once the peer link is up. */
  pollMs = 1000;

  constructor(
    private roomId: string,
    private token: string,
    private h: SignalingHandlers,
  ) {}

  connect() {
    void this.streamLoop();
    void this.pollLoop();
  }

  /** "stream", "poll" or "stream+poll": which paths are working right now (diagnostics). */
  get mode(): string {
    return [this.streamUp && "stream", this.pollUp && "poll"].filter(Boolean).join("+") || "none";
  }

  /** Messages are POSTed strictly in order so offer → candidates never reorder. */
  send(kind: SignalKind, data: unknown): Promise<void> {
    this.queue = this.queue.then(() => this.post(kind, data));
    return this.queue;
  }

  /** Tell the server we're leaving, even while the page is unloading. */
  leave() {
    if (this.closed) return;
    this.closed = true;
    this.ctrl?.abort();
    const url = `/api/session/${this.roomId}/leave`;
    const body = JSON.stringify({ token: this.token });
    try {
      if (!navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) throw new Error();
    } catch {
      void fetch(url, { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(
        () => {},
      );
    }
  }

  close() {
    this.closed = true;
    this.ctrl?.abort();
  }

  private async post(kind: SignalKind, data: unknown) {
    for (let attempt = 0; attempt < 4 && !this.closed; attempt++) {
      try {
        const res = await fetch(`/api/session/${this.roomId}/signal`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ kind, data }),
          cache: "no-store",
        });
        if (res.ok) return;
        if (res.status === 410 || res.status === 401) {
          this.expire();
          return;
        }
        if (res.status !== 429 && res.status < 500) {
          this.failedPosts++;
          return;
        }
      } catch {
        /* network blip: retry */
      }
      await sleep(400 * (attempt + 1));
    }
    if (!this.closed) this.failedPosts++;
  }

  private expire() {
    if (this.terminal) return;
    this.terminal = true;
    this.ctrl?.abort();
    this.h.onExpired();
  }

  private live() {
    return !this.closed && !this.terminal;
  }

  private setUp(path: "stream" | "poll", up: boolean) {
    const wasUp = this.streamUp || this.pollUp;
    if (path === "stream") this.streamUp = up;
    else this.pollUp = up;
    const isUp = this.streamUp || this.pollUp;
    if (isUp && !wasUp) this.h.onStream("open");
    if (!isUp && wasUp && this.live()) this.h.onStream("reconnecting");
  }

  /** Either path saying hello means signaling works. */
  private markReady(peer: string | null) {
    if (this.ready) return;
    this.ready = true;
    this.h.onReady(peer);
  }

  /* ----------------------------------------------------------------- poll */

  private async pollLoop() {
    let failures = 0;
    while (this.live()) {
      try {
        const res = await fetch(`/api/session/${this.roomId}/poll`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ after: this.lastSeq }),
          cache: "no-store",
        });
        if (res.status === 401 || res.status === 404 || res.status === 410) return this.expire();
        if (!res.ok) throw new Error(String(res.status));
        const { events } = (await res.json()) as {
          events: Array<{ seq: number; event: string; data: Record<string, unknown> }>;
        };
        failures = 0;
        this.setUp("poll", true);
        this.markReady(null);
        // The server's log is authoritative: a number it no longer has (trimmed) is not worth waiting for.
        if (events.length && events[0].seq > this.lastSeq + 1 && !this.held.has(this.lastSeq + 1)) {
          this.lastSeq = events[0].seq - 1;
        }
        for (const e of events) this.accept(e.seq, e.event, e.data ?? {}, "poll");
      } catch {
        if (!this.live()) return;
        this.setUp("poll", false);
        if (++failures > MAX_POLL_FAILURES && !this.streamUp) {
          this.h.onStream("lost");
          return;
        }
      }
      await sleep(this.pollMs);
    }
  }

  /* --------------------------------------------------------------- stream */

  private async streamLoop() {
    let attempt = 0;
    while (this.live()) {
      try {
        this.ctrl = new AbortController();
        const res = await fetch(`/api/session/${this.roomId}/events`, {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: this.ctrl.signal,
          cache: "no-store",
        });
        if (res.status === 401 || res.status === 404) return this.expire();
        if (!res.ok || !res.body) throw new Error("stream");
        attempt = 0;
        await this.read(res.body);
      } catch {
        /* polling carries on regardless */
      }
      this.setUp("stream", false);
      if (!this.live()) return;
      await sleep(Math.min(10_000, 600 * ++attempt));
    }
  }

  private async read(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        this.dispatch(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    }
  }

  private dispatch(block: string) {
    let event = "message";
    let data = "";
    let seq = 0;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
      else if (line.startsWith("id:")) seq = Number(line.slice(3).trim()) || 0;
    }
    if (!data) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (event === "ready") {
      this.setUp("stream", true);
      this.markReady((payload.peer as string | null) ?? null);
      return;
    }
    if (seq) this.accept(seq, event, payload, "stream");
    else this.handle(event, payload); // "expired" / "closed" on room teardown
  }

  /* ------------------------------------------------------------ ordering */

  /** Handle each numbered message exactly once, in order, whichever path delivered it. */
  private accept(seq: number, event: string, payload: Record<string, unknown>, path: "stream" | "poll") {
    if (seq <= this.lastSeq || this.held.has(seq)) return;
    this.via[path]++;
    this.held.set(seq, { event, payload });
    for (let next = this.held.get(this.lastSeq + 1); next; next = this.held.get(this.lastSeq + 1)) {
      this.held.delete(++this.lastSeq);
      this.handle(next.event, next.payload);
      if (!this.live()) return;
    }
  }

  private handle(event: string, payload: Record<string, unknown>) {
    switch (event) {
      case "peer-joined":
        this.h.onPeerJoined(String(payload.label ?? "Device"));
        break;
      case "peer-left":
        this.h.onPeerLeft();
        break;
      case "signal":
        this.h.onSignal(payload.kind as SignalKind, payload.data);
        break;
      case "expired":
      case "closed":
        this.expire();
        break;
    }
  }
}
