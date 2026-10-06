import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chooseChunkSize, chunkLength, readChunks, totalChunksFor } from "@/lib/webrtc/chunker";
import { decodeFrame, encodeControl, encodeFrame, parseControl } from "@/lib/webrtc/protocol";

describe("binary frames", () => {
  it("round-trips identity and payload", () => {
    const payload = new Uint8Array(randomBytes(1000));
    const f = decodeFrame(encodeFrame(7, 123456, payload))!;
    expect(f.fileIndex).toBe(7);
    expect(f.chunkIndex).toBe(123456);
    expect(Buffer.from(f.payload).equals(Buffer.from(payload))).toBe(true);
  });
  it("rejects truncated frames", () => {
    expect(decodeFrame(new ArrayBuffer(4))).toBeNull();
  });
});

describe("control messages", () => {
  it("round-trips a valid message", () => {
    const msg = { type: "file-complete", transferId: "abcdef0123456789", index: 2, sha256: "a".repeat(64) } as const;
    expect(parseControl(encodeControl(msg))).toEqual(msg);
  });
  it("drops garbage, bad hashes and oversize input", () => {
    expect(parseControl("not json")).toBeNull();
    expect(parseControl(JSON.stringify({ type: "nope" }))).toBeNull();
    expect(
      parseControl(JSON.stringify({ type: "file-complete", transferId: "abcdef0123456789", index: 0, sha256: "xyz" })),
    ).toBeNull();
    expect(parseControl("x".repeat(2_000_000))).toBeNull();
  });
  it("validates transfer-start limits", () => {
    const base = { type: "transfer-start", transferId: "abcdef0123456789", chunkSize: 65536, totalBytes: 10, files: [] };
    expect(parseControl(JSON.stringify(base))).toBeNull(); // needs at least one file
    expect(
      parseControl(
        JSON.stringify({ ...base, chunkSize: 10 ** 9, files: [{ name: "a", size: 10, mime: "", totalChunks: 1 }] }),
      ),
    ).toBeNull();
  });
});

describe("chunking", () => {
  it("computes chunk counts and lengths", () => {
    expect(totalChunksFor(0, 100)).toBe(0);
    expect(totalChunksFor(100, 100)).toBe(1);
    expect(totalChunksFor(101, 100)).toBe(2);
    expect(chunkLength(1, 101, 100)).toBe(1);
    expect(chunkLength(0, 101, 100)).toBe(100);
  });

  it("adapts to the negotiated SCTP limit and WebKit", () => {
    expect(chooseChunkSize({ maxMessageSize: 262144 })).toBe(128 * 1024);
    expect(chooseChunkSize({ maxMessageSize: 262144, webkitInvolved: true })).toBe(64 * 1024);
    expect(chooseChunkSize({ maxMessageSize: 32 * 1024 })).toBeLessThanOrEqual(32 * 1024);
  });

  it("reads a file back byte-for-byte, from any start chunk", async () => {
    const data = randomBytes(1_000_003);
    const blob = new Blob([data]);
    const cs = 64 * 1024;
    for (const start of [0, 3, 15]) {
      const parts: Buffer[] = [];
      let expectIndex = start;
      for await (const c of readChunks(blob, cs, start, undefined, 256 * 1024)) {
        expect(c.index).toBe(expectIndex++);
        parts.push(Buffer.from(c.data));
      }
      expect(Buffer.concat(parts).equals(data.subarray(start * cs))).toBe(true);
    }
  });
});
