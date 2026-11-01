import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, RoomStore, type Conn } from "@/server/rooms";

function conn() {
  const events: Array<{ event: string; data: unknown }> = [];
  let closed = false;
  const c: Conn = { send: (event, data) => void events.push({ event, data }), close: () => void (closed = true) };
  return { c, events, isClosed: () => closed };
}

function setup() {
  let now = 1_000_000;
  const store = new RoomStore(DEFAULT_LIMITS, () => now);
  return { store, advance: (ms: number) => void (now += ms) };
}

describe("signaling rooms", () => {
  it("creates unguessable ids, tokens and a 6-digit code", () => {
    const { store } = setup();
    const a = store.create("Windows");
    const b = store.create("Windows");
    expect(a.roomId).not.toBe(b.roomId);
    expect(a.roomId.length).toBeGreaterThanOrEqual(22); // 128 bits, base64url
    expect(a.joinSecret.length).toBeGreaterThanOrEqual(22);
    expect(a.hostToken.length).toBeGreaterThanOrEqual(32);
    expect(a.code).toMatch(/^\d{6}$/);
  });

  it("only joins with the right secret or code, and only once", () => {
    const { store } = setup();
    const r = store.create("Windows");
    expect(store.join({ roomId: r.roomId, secret: "x".repeat(22) }, "iPhone")).toEqual({ ok: false, reason: "forbidden" });
    const joined = store.join({ code: r.code }, "iPhone");
    expect(joined.ok).toBe(true);
    // second sender is turned away: a stranger can't barge into a paired session
    expect(store.join({ roomId: r.roomId, secret: r.joinSecret }, "Eve")).toEqual({ ok: false, reason: "occupied" });
    expect(store.join({ code: r.code }, "Eve").ok).toBe(false);
  });

  it("authenticates tokens per role and rejects everything else", () => {
    const { store } = setup();
    const r = store.create("Windows");
    const j = store.join({ roomId: r.roomId, secret: r.joinSecret }, "iPhone");
    if (!j.ok) throw new Error("join failed");
    expect(store.authenticate(r.roomId, r.hostToken)).toBe("host");
    expect(store.authenticate(r.roomId, j.guestToken)).toBe("guest");
    expect(store.authenticate(r.roomId, r.joinSecret)).toBeNull(); // the QR secret is not a session token
    expect(store.authenticate(r.roomId, "")).toBeNull();
    expect(store.authenticate("nope", r.hostToken)).toBeNull();
  });

  it("relays offer/answer/ICE between the two peers, queueing for a late listener", () => {
    const { store } = setup();
    const r = store.create("Windows");
    const j = store.join({ roomId: r.roomId, secret: r.joinSecret }, "iPhone");
    if (!j.ok) throw new Error();
    const host = conn();
    store.attach(r.roomId, "host", host.c);
    expect(host.events.map((e) => e.event)).toContain("ready");

    // guest offers before its own stream is attached; host receives immediately
    expect(store.relay(r.roomId, "guest", "offer", { sdp: "o" })).toBe(true);
    expect(host.events.at(-1)).toEqual({ event: "signal", data: { kind: "offer", data: { sdp: "o" } } });

    // host answers while the guest isn't listening yet → queued, delivered on attach
    store.relay(r.roomId, "host", "answer", { sdp: "a" });
    const guest = conn();
    store.attach(r.roomId, "guest", guest.c);
    expect(guest.events.some((e) => e.event === "signal" && (e.data as { kind: string }).kind === "answer")).toBe(true);
  });

  it("tells the host when the sender leaves, and reopens the slot", () => {
    const { store } = setup();
    const r = store.create("Windows");
    const host = conn();
    store.attach(r.roomId, "host", host.c);
    const j = store.join({ roomId: r.roomId, secret: r.joinSecret }, "iPhone");
    expect(host.events.some((e) => e.event === "peer-joined")).toBe(true);
    if (!j.ok) throw new Error();
    store.leave(r.roomId, "guest");
    expect(host.events.some((e) => e.event === "peer-left")).toBe(true);
    expect(store.authenticate(r.roomId, j.guestToken)).toBeNull();
    expect(store.join({ code: r.code }, "iPhone 2").ok).toBe(true);
  });

  it("destroys the room when the receiver leaves", () => {
    const { store } = setup();
    const r = store.create("Windows");
    const j = store.join({ roomId: r.roomId, secret: r.joinSecret }, "iPhone");
    if (!j.ok) throw new Error();
    const guest = conn();
    store.attach(r.roomId, "guest", guest.c);
    store.leave(r.roomId, "host");
    expect(store.size).toBe(0);
    expect(guest.events.at(-1)?.event).toBe("closed");
    expect(guest.isClosed()).toBe(true);
  });

  it("expires waiting rooms and invalidates the code", () => {
    const { store, advance } = setup();
    const r = store.create("Windows");
    const host = conn();
    store.attach(r.roomId, "host", host.c);
    advance(DEFAULT_LIMITS.waitingTtlMs + 1000);
    store.sweep();
    expect(store.size).toBe(0);
    expect(host.events.at(-1)?.event).toBe("expired");
    expect(store.join({ code: r.code }, "iPhone")).toEqual({ ok: false, reason: "not-found" });
    expect(store.authenticate(r.roomId, r.hostToken)).toBeNull();
  });

  it("expires idle paired rooms but keeps rooms with live streams", () => {
    const { store, advance } = setup();
    const live = store.create("A");
    const idle = store.create("B");
    for (const r of [live, idle]) {
      const j = store.join({ roomId: r.roomId, secret: r.joinSecret }, "p");
      if (!j.ok) throw new Error();
    }
    store.attach(live.roomId, "host", conn().c);
    store.attach(live.roomId, "guest", conn().c);
    advance(DEFAULT_LIMITS.idleTtlMs + 1000);
    store.sweep();
    expect(store.authenticate(live.roomId, live.hostToken)).toBe("host");
    expect(store.authenticate(idle.roomId, idle.hostToken)).toBeNull();
  });

  it("nearby tokens: single use, short-lived, revocable, tied to one room", () => {
    const { store, advance } = setup();
    const r = store.create("Windows");
    const a = store.issueNearby(r.roomId)!;
    expect(a.token).toMatch(/^[0-9a-f]{8}$/);
    // re-issuing revokes the previous token
    const b = store.issueNearby(r.roomId)!;
    expect(store.join({ nearby: a.token }, "iPhone")).toEqual({ ok: false, reason: "not-found" });
    // expired tokens fail (a recording replayed later is useless)
    advance(DEFAULT_LIMITS.nearbyTtlMs + 1);
    expect(store.join({ nearby: b.token }, "iPhone")).toEqual({ ok: false, reason: "not-found" });
    // a live token joins exactly once
    const c = store.issueNearby(r.roomId)!;
    const joined = store.join({ nearby: c.token }, "iPhone");
    expect(joined.ok).toBe(true);
    expect(store.join({ nearby: c.token }, "Eve")).toEqual({ ok: false, reason: "not-found" });
    // a paired room no longer issues tokens
    expect(store.issueNearby(r.roomId)).toBeNull();
  });

  it("pairing by QR or code revokes an outstanding nearby token", () => {
    const { store } = setup();
    const r = store.create("Windows");
    const n = store.issueNearby(r.roomId)!;
    expect(store.join({ code: r.code }, "iPhone").ok).toBe(true);
    expect(store.join({ nearby: n.token }, "Eve")).toEqual({ ok: false, reason: "not-found" });
  });

  it("caps signaling volume per room", () => {
    const { store } = setup();
    const r = store.create("A");
    store.join({ roomId: r.roomId, secret: r.joinSecret }, "p");
    let accepted = 0;
    for (let i = 0; i < DEFAULT_LIMITS.maxSignals + 50; i++) if (store.relay(r.roomId, "host", "ice", {})) accepted++;
    expect(accepted).toBe(DEFAULT_LIMITS.maxSignals);
  });

  it("numbers every message so a stalled stream can be backed up by polling", () => {
    const { store, advance } = setup();
    const r = store.create("Windows");
    store.attach(r.roomId, "host", conn().c);
    const joined = store.join({ roomId: r.roomId, secret: r.joinSecret }, "iPhone");
    if (!joined.ok) throw new Error("join failed");
    // the guest's stream is attached but stalled: whatever it is sent never reaches the device
    const stalled = conn();
    store.attach(r.roomId, "guest", stalled.c);
    store.relay(r.roomId, "host", "answer", { sdp: "a" });
    store.relay(r.roomId, "host", "ice", { c: 1 });
    // polling still gets everything, numbered, and only what's new
    expect(store.poll(r.roomId, "guest", 0)).toEqual([
      { seq: 1, event: "signal", data: { kind: "answer", data: { sdp: "a" } } },
      { seq: 2, event: "signal", data: { kind: "ice", data: { c: 1 } } },
    ]);
    expect(store.poll(r.roomId, "guest", 2)).toEqual([]);
    // the stream carried the same numbers, so the client can de-duplicate
    expect(stalled.events.filter((e) => e.event === "signal")).toHaveLength(2);
    // a reattached stream replays the log; the client skips what it already handled
    const fresh = conn();
    store.attach(r.roomId, "guest", fresh.c);
    expect(fresh.events.map((e) => e.event)).toEqual(["ready", "signal", "signal"]);
    // polling counts as presence
    advance(DEFAULT_LIMITS.guestAbsentMs - 1000);
    store.detach(r.roomId, "guest", fresh.c);
    store.poll(r.roomId, "guest", 2);
    advance(DEFAULT_LIMITS.guestAbsentMs - 1000);
    store.sweep();
    expect(store.authenticate(r.roomId, joined.guestToken)).toBe("guest");
    expect(store.poll("nope", "guest", 0)).toBeNull();
  });
});
