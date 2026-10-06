/** Decimal units, matching what iOS and Windows show for file sizes. */
export function formatBytes(bytes: number, digits?: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3));
  const v = bytes / 1000 ** i;
  const d = digits ?? (i === 0 ? 0 : v >= 100 ? 0 : 1);
  return `${v.toFixed(d)} ${units[i]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** "~4 sec remaining" — coarse on purpose so it doesn't flicker. */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "Estimating…";
  if (seconds < 2) return "Almost done";
  if (seconds < 60) return `~${Math.round(seconds / (seconds < 20 ? 1 : 5)) * (seconds < 20 ? 1 : 5)} sec remaining`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `~${m} min remaining`;
  const h = Math.floor(m / 60);
  return `~${h} h ${m % 60} min remaining`;
}

export function pluralPhotos(n: number): string {
  return `${n} ${n === 1 ? "photo" : "photos"}`;
}

export function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
