import { describe, expect, it } from "vitest";
import { toSelected } from "@/lib/files/file-utils";
import { INITIAL, reduce, type Action, type Machine } from "@/lib/webrtc/connection-state";

const run = (actions: Action[], from: Machine = INITIAL) => actions.reduce(reduce, from);
const photo = (n: string) => toSelected(new File([new Uint8Array(4)], n, { type: "image/heic" }));
const pairing = { roomId: "r", code: "123456", link: "https://x/r/r#s", expiresAt: Date.now() + 1000 };

describe("transfer state machine", () => {
  it("sender: pick → select → pair → connect → offer → send → finalize → complete", () => {
    const m = run([
      { type: "PICK_OPEN" },
      { type: "FILES_ADD", files: [photo("a.HEIC"), photo("b.HEIC")] },
      { type: "PAIRING" },
      { type: "CONNECTING", label: "Windows" },
      { type: "CONNECTED", label: "Windows", route: "direct" },
      { type: "OFFER_SENT", summary: { fileCount: 2, totalBytes: 8, names: [] } },
      { type: "TRANSFER_STARTED" },
      { type: "FINALIZING" },
      { type: "COMPLETED" },
    ]);
    expect(m.phase).toBe("completed");
    expect(m.role).toBe("sender");
    expect(m.route).toBe("direct");
    expect(m.files).toHaveLength(2);
  });

  it("receiver: create → wait → peer → connect → offer → receive → complete", () => {
    const m = run([
      { type: "RECEIVE_START" },
      { type: "SESSION_READY", pairing },
      { type: "PEER_JOINED", label: "iPhone" },
      { type: "CONNECTED", label: "iPhone", route: "direct" },
      { type: "OFFER_RECEIVED", summary: { fileCount: 1, totalBytes: 4, names: ["a"] } },
      { type: "TRANSFER_STARTED" },
      { type: "FINALIZING" },
      { type: "COMPLETED" },
    ]);
    expect(m.phase).toBe("completed");
    expect(m.peerLabel).toBe("iPhone");
  });

  it("ignores actions that are illegal from the current phase", () => {
    expect(run([{ type: "COMPLETED" }]).phase).toBe("idle");
    expect(run([{ type: "TRANSFER_STARTED" }]).phase).toBe("idle");
    expect(run([{ type: "FINALIZING" }]).phase).toBe("idle");
    const waiting = run([{ type: "RECEIVE_START" }, { type: "SESSION_READY", pairing }]);
    expect(reduce(waiting, { type: "OFFER_SENT", summary: { fileCount: 1, totalBytes: 1, names: [] } })).toBe(waiting);
  });

  it("a dropped connection pauses progress and restores the exact phase on reconnect", () => {
    const sending = run([
      { type: "FILES_ADD", files: [photo("a.HEIC")] },
      { type: "PAIRING" },
      { type: "CONNECTED", route: "direct" },
      { type: "OFFER_SENT", summary: { fileCount: 1, totalBytes: 4, names: [] } },
      { type: "TRANSFER_STARTED" },
    ]);
    expect(sending.phase).toBe("sending");
    const lost = reduce(sending, { type: "RECONNECTING" });
    expect(lost.phase).toBe("reconnecting");
    expect(lost.resumePhase).toBe("sending");
    const back = reduce(lost, { type: "CONNECTED", route: "direct" });
    expect(back.phase).toBe("sending");
    expect(back.resumePhase).toBeNull();
    // and via the manual Resume path
    const paused = reduce(lost, { type: "PAUSED" });
    expect(paused.phase).toBe("paused");
    expect(reduce(paused, { type: "RESUMED" }).phase).toBe("reconnecting");
    expect(reduce(paused, { type: "CONNECTED", route: "direct" }).phase).toBe("sending");
  });

  it("failure keeps the selected files so the user can retry", () => {
    const m = run([
      { type: "FILES_ADD", files: [photo("a.HEIC")] },
      { type: "PAIRING" },
      { type: "FAILED", code: "connection-failed" },
    ]);
    expect(m.phase).toBe("failed");
    expect(m.error?.code).toBe("connection-failed");
    const back = reduce(m, { type: "BACK_TO_FILES" });
    expect(back.phase).toBe("files-selected");
    expect(back.files).toHaveLength(1);
  });

  it("expiry does not clobber a finished transfer", () => {
    const done = run([{ type: "RECEIVE_START" }, { type: "SESSION_READY", pairing }, { type: "PEER_JOINED", label: "x" }, { type: "CONNECTED", route: null }, { type: "OFFER_RECEIVED", summary: { fileCount: 1, totalBytes: 1, names: [] } }, { type: "TRANSFER_STARTED" }, { type: "COMPLETED" }]);
    expect(reduce(done, { type: "EXPIRED" }).phase).toBe("completed");
    expect(reduce(run([{ type: "RECEIVE_START" }, { type: "SESSION_READY", pairing }]), { type: "EXPIRED" }).phase).toBe("expired");
  });

  it("removing the last file returns to idle; reset always returns to initial", () => {
    const one = run([{ type: "PICK_OPEN" }, { type: "FILES_ADD", files: [photo("a.HEIC")] }]);
    expect(reduce(one, { type: "FILES_REMOVE", id: one.files[0].id }).phase).toBe("idle");
    expect(reduce(one, { type: "RESET" })).toEqual(INITIAL);
  });

  it("send more: a completed sender returns to choosing photos on the same session", () => {
    const done = run([
      { type: "FILES_ADD", files: [photo("a.HEIC")] },
      { type: "PAIRING" },
      { type: "CONNECTED", label: "Windows", route: "direct" },
      { type: "OFFER_SENT", summary: { fileCount: 1, totalBytes: 4, names: [] } },
      { type: "TRANSFER_STARTED" },
      { type: "COMPLETED" },
    ]);
    const again = reduce(done, { type: "SEND_MORE" });
    expect(again.phase).toBe("connected");
    expect(again.files).toHaveLength(0);
    expect(again.peerLabel).toBe("Windows");
    expect(again.route).toBe("direct");
    expect(reduce(again, { type: "OFFER_SENT", summary: { fileCount: 1, totalBytes: 1, names: [] } }).phase).toBe("awaiting-acceptance");
    expect(reduce(INITIAL, { type: "SEND_MORE" })).toBe(INITIAL);
  });

  it("a receiver whose session is complete can be offered another batch", () => {
    const done = run([
      { type: "RECEIVE_START" },
      { type: "SESSION_READY", pairing },
      { type: "PEER_JOINED", label: "iPhone" },
      { type: "CONNECTED", route: "direct" },
      { type: "OFFER_RECEIVED", summary: { fileCount: 1, totalBytes: 1, names: [] } },
      { type: "TRANSFER_STARTED" },
      { type: "COMPLETED" },
    ]);
    expect(reduce(done, { type: "OFFER_RECEIVED", summary: { fileCount: 2, totalBytes: 2, names: [] } }).phase).toBe("awaiting-acceptance");
  });

  it("cancelling the picker returns to idle", () => {
    expect(run([{ type: "PICK_OPEN" }, { type: "PICK_CANCEL" }]).phase).toBe("idle");
  });
});
