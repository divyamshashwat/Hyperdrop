import { sanitizeFileName } from "./file-utils";

export interface ManifestFile {
  index: number;
  /** Safe, de-duplicated name used for saving. */
  name: string;
  size: number;
  mime: string;
  lastModified?: number;
  totalChunks: number;
}

export interface ReceivedFile extends ManifestFile {
  /** Present for in-memory sinks. The File has the original name, type and bytes. */
  file: File | null;
  /** Present when streamed straight to disk. */
  savedAs: string | null;
}

/**
 * Where incoming bytes go. The transfer layer only knows this interface, so
 * browsers with streaming writers get constant memory while everyone else
 * falls back to Blob assembly.
 */
export interface FileSink {
  readonly kind: "memory" | "folder";
  begin(index: number): Promise<void>;
  write(index: number, data: Uint8Array): Promise<void> | void;
  finish(index: number): Promise<ReceivedFile>;
  abort(): Promise<void>;
}

export class MemorySink implements FileSink {
  readonly kind = "memory" as const;
  private parts = new Map<number, Uint8Array[]>();

  constructor(private files: ManifestFile[]) {}

  async begin(index: number) {
    if (!this.parts.has(index)) this.parts.set(index, []);
  }

  write(index: number, data: Uint8Array) {
    this.parts.get(index)?.push(data);
  }

  async finish(index: number): Promise<ReceivedFile> {
    const meta = this.files[index];
    const parts = this.parts.get(index) ?? [];
    this.parts.delete(index); // the File now owns the bytes; drop our references
    const file = new File(parts as BlobPart[], meta.name, {
      type: meta.mime || "application/octet-stream",
      lastModified: meta.lastModified ?? Date.now(),
    });
    return { ...meta, file, savedAs: null };
  }

  async abort() {
    this.parts.clear();
  }
}

/** File System Access API (Chromium desktop): stream straight into a chosen folder. */
interface FsWritable {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export interface FsDir {
  readonly name: string;
  getFileHandle(name: string, opts: { create: boolean }): Promise<{ createWritable(): Promise<FsWritable> }>;
}

export function folderSinkSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export async function pickFolder(): Promise<FsDir | null> {
  try {
    return await (window as unknown as { showDirectoryPicker(o?: object): Promise<FsDir> }).showDirectoryPicker({
      mode: "readwrite",
      id: "origin-receive",
    });
  } catch {
    return null; // user dismissed the picker
  }
}

export class FolderSink implements FileSink {
  readonly kind = "folder" as const;
  private writers = new Map<number, FsWritable>();
  private queues = new Map<number, Promise<void>>();

  constructor(
    private dir: FsDir,
    private files: ManifestFile[],
  ) {}

  async begin(index: number) {
    if (this.writers.has(index)) return;
    const handle = await this.dir.getFileHandle(sanitizeFileName(this.files[index].name), { create: true });
    this.writers.set(index, await handle.createWritable());
    this.queues.set(index, Promise.resolve());
  }

  write(index: number, data: Uint8Array) {
    const w = this.writers.get(index);
    if (!w) throw new Error("no writer");
    const next = (this.queues.get(index) ?? Promise.resolve()).then(() => w.write(data as BufferSource));
    this.queues.set(index, next);
    return next;
  }

  async finish(index: number): Promise<ReceivedFile> {
    await this.queues.get(index);
    await this.writers.get(index)?.close();
    this.writers.delete(index);
    const meta = this.files[index];
    return { ...meta, file: null, savedAs: meta.name };
  }

  async abort() {
    await Promise.allSettled([...this.writers.values()].map((w) => w.abort()));
    this.writers.clear();
  }
}
