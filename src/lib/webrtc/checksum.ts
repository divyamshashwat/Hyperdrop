import { Sha256 } from "./sha256";

/** Streaming hasher. `update` takes a copy, so callers may reuse their buffers. */
export interface Hasher {
  update(data: Uint8Array): void;
  digest(): Promise<string>;
}
export type HasherFactory = () => Hasher;

export const createInlineHasher: HasherFactory = () => {
  const h = new Sha256();
  return {
    update: (d) => void h.update(d),
    digest: async () => h.hex(),
  };
};

interface Pending {
  resolve: (hex: string) => void;
}

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("../../workers/file-hasher.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; hex: string }>) => {
      pending.get(e.data.id)?.resolve(e.data.hex);
      pending.delete(e.data.id);
    };
    worker.onerror = () => {
      worker = null; // fall back to inline hashing for subsequent files
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** Hashes off the main thread when a Worker is available, inline otherwise. */
export const createWorkerHasher: HasherFactory = () => {
  const w = typeof Worker === "undefined" ? null : getWorker();
  if (!w) return createInlineHasher();
  const id = nextId++;
  return {
    update(data) {
      const copy = data.slice();
      w.postMessage({ op: "update", id, buf: copy.buffer }, [copy.buffer]);
    },
    digest: () =>
      new Promise<string>((resolve) => {
        pending.set(id, { resolve });
        w.postMessage({ op: "digest", id });
      }),
  };
};

/** One-shot digest of a Blob, streamed through the same hasher. */
export async function hashBlob(blob: Blob, factory: HasherFactory = createInlineHasher): Promise<string> {
  const h = factory();
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
  }
  return h.digest();
}
