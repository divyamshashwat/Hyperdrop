import { z } from "zod";

/**
 * Wire protocol over the ordered, reliable DataChannel.
 *
 *   text frames   → small JSON control messages (validated, untrusted input)
 *   binary frames → [u32 fileIndex][u32 chunkIndex][payload…]
 *
 * (fileIndex, chunkIndex) is the deterministic identity of every chunk, which
 * is what makes ack ranges and resume possible without changing the engine.
 */

export const PROTOCOL_VERSION = 1;
export const FRAME_HEADER_BYTES = 8;
export const MAX_FILES = 5000;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const id = z.string().min(8).max(64);
const idx = z.number().int().min(0).max(MAX_FILES);

export const fileMetaSchema = z.object({
  name: z.string().min(1).max(1024),
  size: z.number().int().min(0).max(2 ** 50),
  mime: z.string().max(128),
  lastModified: z.number().int().min(0).optional(),
  totalChunks: z.number().int().min(0).max(2 ** 40),
});
export type FileMeta = z.infer<typeof fileMetaSchema>;

export const controlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), v: z.number().int(), label: z.string().max(64) }),
  z.object({
    type: z.literal("transfer-start"),
    transferId: id,
    chunkSize: z.number().int().min(1024).max(256 * 1024),
    totalBytes: z.number().int().min(0).max(2 ** 50),
    files: z.array(fileMetaSchema).min(1).max(MAX_FILES),
  }),
  z.object({
    type: z.literal("accept"),
    transferId: id,
    /** Contiguous chunks already stored per file (resume point). */
    have: z.array(z.number().int().min(0)).max(MAX_FILES),
    /** File indices already hash-verified. */
    verified: z.array(idx).max(MAX_FILES),
  }),
  z.object({ type: z.literal("reject"), transferId: id }),
  z.object({
    type: z.literal("file-start"),
    transferId: id,
    index: idx,
    startChunk: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("file-complete"),
    transferId: id,
    index: idx,
    sha256: hex64,
  }),
  z.object({ type: z.literal("transfer-complete"), transferId: id }),
  /**
   * Cumulative range ACK. The channel is ordered and reliable, so "received through
   * chunk N of file i" plus the cumulative byte count is a complete range.
   */
  z.object({
    type: z.literal("ack"),
    transferId: id,
    index: idx,
    chunk: z.number().int().min(0),
    /** Total bytes stored by the receiver so far (drives the sender's in-flight window). */
    bytes: z.number().int().min(0).optional(),
  }),
  // Synthetic throughput benchmark: same channel, no files.
  z.object({ type: z.literal("bench-start"), id, bytes: z.number().int().min(1).max(2 ** 32), chunkSize: z.number().int().min(1024).max(256 * 1024) }),
  z.object({ type: z.literal("bench-end"), id }),
  z.object({ type: z.literal("bench-result"), id, bytes: z.number().int().min(0), ms: z.number().min(0) }),
  z.object({ type: z.literal("file-verified"), transferId: id, index: idx, ok: z.boolean() }),
  z.object({
    type: z.literal("transfer-verified"),
    transferId: id,
    ok: z.boolean(),
    failed: z.array(idx).max(MAX_FILES),
  }),
  z.object({ type: z.literal("cancel"), transferId: id, reason: z.string().max(64) }),
]);
export type Control = z.infer<typeof controlSchema>;

export function encodeControl(msg: Control): string {
  return JSON.stringify(msg);
}

export function parseControl(text: string): Control | null {
  if (text.length > 1_000_000) return null;
  try {
    const r = controlSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function encodeFrame(fileIndex: number, chunkIndex: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(buf);
  view.setUint32(0, fileIndex);
  view.setUint32(4, chunkIndex);
  new Uint8Array(buf, FRAME_HEADER_BYTES).set(payload);
  return buf;
}

export function decodeFrame(buf: ArrayBuffer): { fileIndex: number; chunkIndex: number; payload: Uint8Array } | null {
  if (buf.byteLength < FRAME_HEADER_BYTES) return null;
  const view = new DataView(buf);
  return {
    fileIndex: view.getUint32(0),
    chunkIndex: view.getUint32(4),
    payload: new Uint8Array(buf, FRAME_HEADER_BYTES),
  };
}

/** Synthetic benchmark frames use this file index so they can never be mistaken for a photo. */
export const BENCH_FILE_INDEX = 0xffffffff;

export function isBenchFrame(buf: ArrayBuffer): boolean {
  return buf.byteLength >= FRAME_HEADER_BYTES && new DataView(buf).getUint32(0) === BENCH_FILE_INDEX;
}

export function newTransferId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
