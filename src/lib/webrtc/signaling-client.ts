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

/**
 * Signaling transport: server-sent events down, ordered POSTs up. It only ever
 * carries SDP / ICE blobs. (Swappable for a WebSocket without touching callers.)
 */
export class SignalingClient {
  private closed = false;
  private terminal = false;
  private ctrl: AbortController | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Messages that never reached the server (diagnostics). */
  failedPosts = 0;

  constructor(
    private roomId: string,
    private token: string,
    private h: SignalingHandlers,
  ) {}

  connect() {
    void this.loop();
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
    this.h.onExpired();
  }

  private async loop() {
    let attempt = 0;
    while (!this.closed && !this.terminal) {
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
        this.h.onStream("open");
        await this.read(res.body);
      } catch {
        if (this.closed) return;
      }
      if (this.closed || this.terminal) return;
      if (++attempt > 8) {
        this.h.onStream("lost");
        return;
      }
      this.h.onStream("reconnecting");
      await sleep(Math.min(5000, 600 * attempt));
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
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    switch (event) {
      case "ready":
        this.h.onReady((payload.peer as string | null) ?? null);
        break;
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
