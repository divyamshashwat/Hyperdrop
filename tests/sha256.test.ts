import { createHash, randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Sha256 } from "@/lib/webrtc/sha256";
import { crc32Update } from "@/lib/files/zip";

const ref = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("incremental SHA-256", () => {
  it("matches the reference for boundary lengths", () => {
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 65536, 100_001]) {
      const data = new Uint8Array(randomBytes(n));
      expect(new Sha256().update(data).hex(), `length ${n}`).toBe(ref(data));
    }
  });

  it("is independent of how the input is split", () => {
    const data = new Uint8Array(randomBytes(300_000));
    const h = new Sha256();
    let i = 0;
    const sizes = [1, 7, 63, 64, 65, 1000, 4096, 131_072];
    for (let k = 0; i < data.length; k++) {
      const n = sizes[k % sizes.length];
      h.update(data.subarray(i, i + n));
      i += n;
    }
    expect(h.hex()).toBe(ref(data));
  });

  it("known vector", () => {
    expect(new Sha256().update(new TextEncoder().encode("abc")).hex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("crc32 (zip packaging)", () => {
  it("matches zlib", () => {
    const data = new Uint8Array(randomBytes(50_000));
    expect(crc32Update(0, data)).toBe(crc32(data));
    // incremental
    expect(crc32Update(crc32Update(0, data.subarray(0, 123)), data.subarray(123))).toBe(crc32(data));
  });
});
