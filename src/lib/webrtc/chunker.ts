/**
 * Chunking helpers. Files are read incrementally in large blocks (few async
 * reads) and cut into small frames (safe DataChannel message sizes).
 */

export const DEFAULT_CHUNK = 128 * 1024;
export const SAFE_CHUNK = 64 * 1024;
export const READ_BLOCK = 1024 * 1024;

export function totalChunksFor(size: number, chunkSize: number): number {
  return size === 0 ? 0 : Math.ceil(size / chunkSize);
}

export function chunkLength(index: number, size: number, chunkSize: number): number {
  return Math.min(chunkSize, size - index * chunkSize);
}

/**
 * Legacy chunk chooser (used by LEGACY_TUNING comparisons and tests). New code
 * resolves chunk size through `resolveTuning` in tuning.ts.
 */
export function chooseChunkSize(opts: { maxMessageSize?: number; webkitInvolved?: boolean }): number {
  const base = opts.webkitInvolved ? SAFE_CHUNK : DEFAULT_CHUNK;
  const max = opts.maxMessageSize && Number.isFinite(opts.maxMessageSize) ? opts.maxMessageSize - 16 : base;
  return Math.max(16 * 1024, Math.min(base, max));
}

export interface BlockChunk {
  index: number;
  data: Uint8Array;
}

/**
 * Yields chunks of `file` starting at `startChunk` up to (excluding) `endChunk`.
 * The next block is read while the caller is busy sending the current one.
 */
export async function* readChunks(
  file: Blob,
  chunkSize: number,
  startChunk = 0,
  endChunk = totalChunksFor(file.size, chunkSize),
  blockBytes = READ_BLOCK,
): AsyncGenerator<BlockChunk> {
  const perBlock = Math.max(1, Math.floor(blockBytes / chunkSize));
  const readBlock = async (first: number) => {
    const last = Math.min(first + perBlock, endChunk);
    const start = first * chunkSize;
    const end = Math.min(file.size, last * chunkSize);
    return { first, last, bytes: new Uint8Array(await file.slice(start, end).arrayBuffer()) };
  };
  let next: Promise<Awaited<ReturnType<typeof readBlock>>> | null =
    startChunk < endChunk ? readBlock(startChunk) : null;
  while (next) {
    const block = await next;
    next = block.last < endChunk ? readBlock(block.last) : null;
    for (let i = block.first; i < block.last; i++) {
      const off = (i - block.first) * chunkSize;
      yield { index: i, data: block.bytes.subarray(off, off + chunkLength(i, file.size, chunkSize)) };
    }
  }
}
