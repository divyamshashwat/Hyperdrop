import { detectKind, extensionOf, type FileKind } from "./file-type";

export interface SelectedFile {
  /** Stable id for React keys and removal. */
  id: string;
  /** The untouched original. Its bytes are what gets transferred. */
  file: File;
  name: string;
  size: number;
  ext: string;
  kind: FileKind;
}

let counter = 0;

export function toSelected(file: File): SelectedFile {
  return {
    id: `${file.name}:${file.size}:${file.lastModified}:${counter++}`,
    file,
    name: file.name,
    size: file.size,
    ext: extensionOf(file.name).toUpperCase(),
    kind: detectKind(file),
  };
}

export function totalSize(files: Array<{ size: number }>): number {
  return files.reduce((n, f) => n + f.size, 0);
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Peer-supplied names are untrusted: strip path separators, control and bidi
 * characters, Windows-reserved names and trailing dots/spaces. Never executed,
 * only used as a download / save name.
 */
export function sanitizeFileName(raw: string, fallback = "file"): string {
  let name = raw
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*‪-‮⁦-⁩]/g, "_")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .trim();
  if (!name) name = fallback;
  if (RESERVED.test(name)) name = `_${name}`;
  if (name.length > 180) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : ""; // keep the original-case extension
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name;
}

/** Make a batch of names unique (case-insensitively) without losing extensions. */
export function dedupeNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    let candidate = n;
    let i = 2;
    const dot = n.lastIndexOf(".");
    const stem = dot > 0 ? n.slice(0, dot) : n;
    const ext = dot > 0 ? n.slice(dot) : "";
    while (used.has(candidate.toLowerCase())) candidate = `${stem} (${i++})${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
