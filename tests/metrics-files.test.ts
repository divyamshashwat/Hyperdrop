import { describe, expect, it } from "vitest";
import { detectKind, sniffKind } from "@/lib/files/file-type";
import { dedupeNames, sanitizeFileName, toSelected } from "@/lib/files/file-utils";
import { formatBytes, formatCode, formatEta, formatSpeed } from "@/lib/files/format";
import { percentage, RollingMeter } from "@/lib/transfer/metrics";

describe("file kind detection", () => {
  it("does not depend on MIME alone", () => {
    expect(detectKind({ name: "IMG_8327.HEIC", type: "" })).toBe("HEIC");
    expect(detectKind({ name: "IMG_8327.heic", type: "application/octet-stream" })).toBe("HEIC");
    expect(detectKind({ name: "x.bin", type: "image/heif" })).toBe("HEIF");
    expect(detectKind({ name: "photo.JPG", type: "" })).toBe("JPEG");
    expect(detectKind({ name: "noext", type: "" })).toBe("OTHER");
  });
  it("sniffs the ftyp brand", async () => {
    const heic = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);
    expect(await sniffKind(new Blob([heic]))).toBe("HEIC");
    expect(await sniffKind(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])]))).toBe("JPEG");
  });
  it("keeps the original File object untouched", () => {
    const f = new File([new Uint8Array(10)], "IMG_1.HEIC", { type: "image/heic" });
    const s = toSelected(f);
    expect(s.file).toBe(f);
    expect(s.ext).toBe("HEIC");
    expect(s.kind).toBe("HEIC");
    expect(s.size).toBe(10);
  });
});

describe("untrusted names", () => {
  it("strips paths, control and bidi characters", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(sanitizeFileName("../../etc/passwd")).not.toMatch(/[\\/]/);
    expect(sanitizeFileName("a/b\\c.heic")).toBe("a_b_c.heic");
    expect(sanitizeFileName("evil‮gnp.exe")).not.toMatch(/‮/);
    expect(sanitizeFileName("CON.txt")).toBe("_CON.txt");
    expect(sanitizeFileName("   ...  ")).toBe("file");
    expect(sanitizeFileName("a".repeat(400) + ".HEIC").endsWith(".HEIC")).toBe(true);
  });
  it("de-duplicates case-insensitively and keeps extensions", () => {
    expect(dedupeNames(["a.heic", "A.HEIC", "a.heic", "b"])).toEqual(["a.heic", "A (2).HEIC", "a (3).heic", "b"]);
  });
});

describe("formatting", () => {
  it("formats sizes, speeds, codes", () => {
    expect(formatBytes(6_800_000)).toBe("6.8 MB");
    expect(formatBytes(68_400_000)).toBe("68.4 MB");
    expect(formatBytes(1_500_000_000)).toBe("1.5 GB");
    expect(formatSpeed(18_700_000)).toBe("18.7 MB/s");
    expect(formatCode("842193")).toBe("842 193");
  });
  it("keeps the ETA coarse", () => {
    expect(formatEta(null)).toBe("Estimating…");
    expect(formatEta(4)).toBe("~4 sec remaining");
    expect(formatEta(47)).toBe("~45 sec remaining");
    expect(formatEta(300)).toBe("~5 min remaining");
  });
});

describe("rolling transfer meter", () => {
  it("smooths speed and estimates remaining time", () => {
    let t = 0;
    const m = new RollingMeter(3000, () => t);
    let bytes = 0;
    for (let i = 0; i < 40; i++) {
      t += 100;
      bytes += 1_000_000; // a steady 10 MB/s
      m.record(bytes);
    }
    const r = m.read(100_000_000);
    expect(r.bytesPerSecond).toBeGreaterThan(9_000_000);
    expect(r.bytesPerSecond).toBeLessThan(11_000_000);
    expect(r.etaSeconds).toBeGreaterThan(5);
    expect(r.etaSeconds).toBeLessThan(8);
  });
  it("does not spike on a burst", () => {
    let t = 0;
    const m = new RollingMeter(3000, () => t);
    let bytes = 0;
    for (let i = 0; i < 30; i++) {
      t += 100;
      bytes += 1_000_000;
      m.record(bytes);
    }
    m.read(1e9);
    t += 100;
    bytes += 20_000_000; // one huge chunk
    m.record(bytes);
    expect(m.read(1e9).bytesPerSecond).toBeLessThan(25_000_000);
  });
  it("computes percentage safely", () => {
    expect(percentage(50, 100)).toBe(50);
    expect(percentage(5, 0)).toBe(0);
    expect(percentage(500, 100)).toBe(100);
  });
});
