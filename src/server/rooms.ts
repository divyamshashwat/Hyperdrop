import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Ephemeral signaling rooms. Everything lives in memory and is destroyed on
 * completion, departure or timeout. Nothing here ever sees file bytes or names:
 * only SDP / ICE blobs and a short device label are relayed.
 */

export type Role = "host" | "guest";
export type SignalKind = "offer" | "answer" | "ice" | "bye";

export interface Conn {
  send(event: string, data: unknown): void;
  close(): void;
}

interface Room {
  id: string;
  code: string;
  joinSecret: string;
  hostToken: string;
  guestToken: string | null;
  labels: Record<Role, string>;
  createdAt: number;
  lastActivity: number;
  guestSeenAt: number;
  conns: Partial<Record<Role, Conn>>;
  pending: Record<Role, Array<{ event: string; data: unknown }>>;
  signalCount: number;
  /** Current Nearby token (8 hex chars = 32 bits), if one is being broadcast. */
  nearby: { token: string; expiresAt: number } | null;
}

export interface RoomLimits {
  waitingTtlMs: number;
  idleTtlMs: number;
  maxLifetimeMs: number;
  guestAbsentMs: number;
  maxSignals: number;
  maxPending: number;
  /** A Nearby token is only good for one short broadcast window. */
  nearbyTtlMs: number;
}

export const DEFAULT_LIMITS: RoomLimits = {
  waitingTtlMs: 10 * 60_000,
  idleTtlMs: 20 * 60_000,
  maxLifetimeMs: 4 * 60 * 60_000,
  guestAbsentMs: 45_000,
  maxSignals: 600,
  maxPending: 64,
  nearbyTtlMs: 20_000,
};

const token = (bytes: number) => randomBytes(bytes).toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export type JoinResult =
  | { ok: true; roomId: string; guestToken: string; hostLabel: string }
  | { ok: false; reason: "not-found" | "occupied" | "forbidden" };

export class RoomStore {
  private rooms = new Map<string, Room>();
  private codes = new Map<string, string>();
  private nearbyTokens = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private limits: RoomLimits = DEFAULT_LIMITS,
    private now: () => number = Date.now,
  ) {}

  startSweeper(intervalMs = 10_000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), intervalMs);
    this.timer.unref?.();
  }

  stopSweeper() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get size() {
    return this.rooms.size;
  }

  create(label: string) {
    let code = "";
    do {
      code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    } while (this.codes.has(code));
    const t = this.now();
    const room: Room = {
      id: token(16), // 128 bits
      code,
      joinSecret: token(16),
      hostToken: token(24),
      guestToken: null,
      labels: { host: label, guest: "" },
      createdAt: t,
      lastActivity: t,
      guestSeenAt: t,
      conns: {},
      pending: { host: [], guest: [] },
      signalCount: 0,
      nearby: null,
    };
    this.rooms.set(room.id, room);
    this.codes.set(code, room.id);
    return {
      roomId: room.id,
      hostToken: room.hostToken,
      joinSecret: room.joinSecret,
      code,
      expiresAt: t + this.limits.waitingTtlMs,
    };
  }

  /**
   * Issue a fresh Nearby token for a waiting room (the receiver is about to broadcast it).
   * 32 random bits from a CSPRNG; any previous token for the room is revoked.
   */
  issueNearby(roomId: string): { token: string; expiresAt: number } | null {
    const room = this.rooms.get(roomId);
    if (!room || room.guestToken) return null;
    if (room.nearby) this.nearbyTokens.delete(room.nearby.token);
    let token = "";
    do {
      token = randomBytes(4).toString("hex");
    } while (this.nearbyTokens.has(token));
    room.nearby = { token, expiresAt: this.now() + this.limits.nearbyTtlMs };
    room.lastActivity = this.now();
    this.nearbyTokens.set(token, room.id);
    return { ...room.nearby };
  }

  /** Join by (roomId + QR secret), the short numeric code, or a heard Nearby token. */
  join(by: { roomId: string; secret: string } | { code: string } | { nearby: string }, label: string): JoinResult {
    this.sweep();
    let room: Room | undefined;
    if ("nearby" in by) {
      const id = this.nearbyTokens.get(by.nearby);
      room = id ? this.rooms.get(id) : undefined;
      if (!room || !room.nearby || room.nearby.token !== by.nearby || room.nearby.expiresAt < this.now()) {
        return { ok: false, reason: "not-found" };
      }
      // Single use: a recording of the signal is worthless after this.
      this.nearbyTokens.delete(by.nearby);
      room.nearby = null;
    } else if ("code" in by) {
      const id = this.codes.get(by.code);
      room = id ? this.rooms.get(id) : undefined;
    } else {
      room = this.rooms.get(by.roomId);
      if (room && !safeEqual(room.joinSecret, by.secret)) return { ok: false, reason: "forbidden" };
    }
    if (!room) return { ok: false, reason: "not-found" };
    if (room.guestToken) return { ok: false, reason: "occupied" };
    room.guestToken = token(24);
    if (room.nearby) {
      this.nearbyTokens.delete(room.nearby.token); // paired by other means: stop honouring the broadcast
      room.nearby = null;
    }
    room.labels.guest = label;
    room.guestSeenAt = room.lastActivity = this.now();
    this.codes.delete(room.code); // the numeric code is single-use
    this.deliver(room, "host", "peer-joined", { label });
    return { ok: true, roomId: room.id, guestToken: room.guestToken, hostLabel: room.labels.host };
  }

  authenticate(roomId: string, bearer: string): Role | null {
    const room = this.rooms.get(roomId);
    if (!room || !bearer) return null;
    if (safeEqual(room.hostToken, bearer)) return "host";
    if (room.guestToken && safeEqual(room.guestToken, bearer)) return "guest";
    return null;
  }

  attach(roomId: string, role: Role, conn: Conn): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.conns[role]?.close();
    room.conns[role] = conn;
    room.lastActivity = this.now();
    if (role === "guest") room.guestSeenAt = this.now();
    const other: Role = role === "host" ? "guest" : "host";
    conn.send("ready", {
      role,
      peer: other === "guest" ? (room.guestToken ? room.labels.guest : null) : room.labels.host,
    });
    for (const m of room.pending[role].splice(0)) conn.send(m.event, m.data);
    return true;
  }

  detach(roomId: string, role: Role, conn: Conn) {
    const room = this.rooms.get(roomId);
    if (room && room.conns[role] === conn) {
      delete room.conns[role];
      if (role === "guest") room.guestSeenAt = this.now();
    }
  }

  relay(roomId: string, from: Role, kind: SignalKind, data: unknown): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    if (++room.signalCount > this.limits.maxSignals) return false;
    room.lastActivity = this.now();
    this.deliver(room, from === "host" ? "guest" : "host", "signal", { kind, data });
    return true;
  }

  leave(roomId: string, role: Role) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (role === "host") {
      this.destroy(room, "closed");
      return;
    }
    room.conns.guest?.close();
    delete room.conns.guest;
    room.guestToken = null;
    room.labels.guest = "";
    room.pending.guest = [];
    this.codes.set(room.code, room.id); // a new sender may pair again
    this.deliver(room, "host", "peer-left", {});
  }

  sweep() {
    const t = this.now();
    for (const room of [...this.rooms.values()]) {
      if (room.nearby && room.nearby.expiresAt < t) {
        this.nearbyTokens.delete(room.nearby.token);
        room.nearby = null;
      }
      const waiting = !room.guestToken;
      if (t - room.createdAt > this.limits.maxLifetimeMs) {
        this.destroy(room, "expired");
      } else if (waiting && t - room.createdAt > this.limits.waitingTtlMs) {
        this.destroy(room, "expired");
      } else if (!waiting && !room.conns.host && !room.conns.guest && t - room.lastActivity > this.limits.idleTtlMs) {
        this.destroy(room, "expired");
      } else if (!waiting && !room.conns.guest && t - room.guestSeenAt > this.limits.guestAbsentMs) {
        // Sender vanished without saying goodbye: free the slot.
        this.leave(room.id, "guest");
      }
    }
  }

  private deliver(room: Room, to: Role, event: string, data: unknown) {
    const conn = room.conns[to];
    if (conn) {
      conn.send(event, data);
      return;
    }
    const q = room.pending[to];
    if (q.length < this.limits.maxPending) q.push({ event, data });
  }

  private destroy(room: Room, event: "expired" | "closed") {
    for (const role of ["host", "guest"] as const) {
      const c = room.conns[role];
      if (c) {
        c.send(event, {});
        c.close();
      }
    }
    this.codes.delete(room.code);
    if (room.nearby) this.nearbyTokens.delete(room.nearby.token);
    this.rooms.delete(room.id);
  }
}

const g = globalThis as unknown as { __originRooms?: RoomStore };

/** One store per server process, shared across route bundles in dev. */
export function getRoomStore(): RoomStore {
  // In dev, hot reload can leave an instance of an *older* RoomStore on globalThis; replace it.
  if (g.__originRooms && !(g.__originRooms instanceof RoomStore)) {
    (g.__originRooms as { stopSweeper?: () => void }).stopSweeper?.();
    g.__originRooms = undefined;
  }
  if (!g.__originRooms) {
    g.__originRooms = new RoomStore();
    g.__originRooms.startSweeper();
  }
  return g.__originRooms;
}
