/**
 * File-kind detection. MIME types from iOS/Android/Windows are unreliable
 * (HEIC often arrives as "" or "application/octet-stream"), so the extension
 * counts as much as the MIME, and the first bytes settle it when needed.
 */

export type FileKind = "HEIC" | "HEIF" | "JPEG" | "PNG" | "WEBP" | "GIF" | "AVIF" | "TIFF" | "RAW" | "VIDEO" | "OTHER";

const BY_EXT: Record<string, FileKind> = {
  heic: "HEIC",
  heics: "HEIC",
  heif: "HEIF",
  heifs: "HEIF",
  hif: "HEIF",
  jpg: "JPEG",
  jpeg: "JPEG",
  jpe: "JPEG",
  png: "PNG",
  webp: "WEBP",
  gif: "GIF",
  avif: "AVIF",
  tif: "TIFF",
  tiff: "TIFF",
  dng: "RAW",
  cr2: "RAW",
  cr3: "RAW",
  nef: "RAW",
  arw: "RAW",
  mov: "VIDEO",
  mp4: "VIDEO",
  m4v: "VIDEO",
};

const BY_MIME: Record<string, FileKind> = {
  "image/heic": "HEIC",
  "image/heic-sequence": "HEIC",
  "image/heif": "HEIF",
  "image/heif-sequence": "HEIF",
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/webp": "WEBP",
  "image/gif": "GIF",
  "image/avif": "AVIF",
  "image/tiff": "TIFF",
  "video/quicktime": "VIDEO",
  "video/mp4": "VIDEO",
};

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : "";
}

export function detectKind(file: { name: string; type?: string }): FileKind {
  const byExt = BY_EXT[extensionOf(file.name)];
  if (byExt) return byExt;
  const mime = (file.type ?? "").toLowerCase();
  return BY_MIME[mime] ?? (mime.startsWith("image/") ? "OTHER" : "OTHER");
}

/** Sniff the ISO-BMFF `ftyp` brand to tell HEIC from HEIF (and catch mislabeled files). */
export async function sniffKind(blob: Blob): Promise<FileKind | null> {
  try {
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const text = (a: number, b: number) => String.fromCharCode(...head.subarray(a, b));
    if (head[0] === 0xff && head[1] === 0xd8) return "JPEG";
    if (head[0] === 0x89 && text(1, 4) === "PNG") return "PNG";
    if (text(4, 8) === "ftyp") {
      const brand = text(8, 12);
      if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "HEIC";
      if (["mif1", "msf1", "heim", "heis"].includes(brand)) return "HEIF";
      if (brand === "avif") return "AVIF";
      if (["qt  ", "isom", "mp42"].includes(brand)) return "VIDEO";
    }
  } catch {
    /* unreadable: caller falls back to the declared kind */
  }
  return null;
}

/** Browsers other than Safari cannot decode HEIC, so don't even try to preview it there. */
export function isHeifFamily(kind: FileKind): boolean {
  return kind === "HEIC" || kind === "HEIF";
}
