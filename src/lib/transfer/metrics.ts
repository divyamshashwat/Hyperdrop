export interface MetricsSnapshot {
  totalBytes: number;
  bytes: number;
  percentage: number;
  /** Smoothed, bytes per second. */
  bytesPerSecond: number;
  peakBytesPerSecond: number;
  /** Smoothed, seconds; null until there is enough signal. */
  etaSeconds: number | null;
  elapsedMs: number;
  currentFile: string | null;
  currentFileBytes: number;
  currentFileSize: number;
  fileCount: number;
  filesDone: number;
}

export const EMPTY_METRICS: MetricsSnapshot = {
  totalBytes: 0,
  bytes: 0,
  percentage: 0,
  bytesPerSecond: 0,
  peakBytesPerSecond: 0,
  etaSeconds: null,
  elapsedMs: 0,
  currentFile: null,
  currentFileBytes: 0,
  currentFileSize: 0,
  fileCount: 0,
  filesDone: 0,
};

/**
 * Rolling-window throughput with exponential smoothing, so the displayed speed
 * and ETA move calmly instead of jittering with every chunk.
 */
export class RollingMeter {
  private samples: Array<{ t: number; bytes: number }> = [];
  private smoothed = 0;
  private eta: number | null = null;
  private peak = 0;
  private startedAt: number | null = null;

  constructor(
    private windowMs = 3000,
    private now: () => number = () => performance.now(),
  ) {}

  /** Record the cumulative number of bytes transferred. */
  record(bytes: number) {
    const t = this.now();
    this.startedAt ??= t;
    this.samples.push({ t, bytes });
    const cutoff = t - this.windowMs;
    while (this.samples.length > 2 && this.samples[1].t < cutoff) this.samples.shift();
  }

  /** Re-baseline after a pause so reconnect gaps don't tank the average. */
  resetWindow(bytes: number) {
    this.samples = [{ t: this.now(), bytes }];
    this.smoothed = 0;
    this.eta = null;
  }

  read(totalBytes: number): { bytesPerSecond: number; peak: number; etaSeconds: number | null; elapsedMs: number } {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.t - first.t < 250) {
      return { bytesPerSecond: this.smoothed, peak: this.peak, etaSeconds: this.eta, elapsedMs: this.elapsed() };
    }
    const raw = Math.max(0, (last.bytes - first.bytes) / ((last.t - first.t) / 1000));
    this.smoothed = this.smoothed === 0 ? raw : this.smoothed * 0.7 + raw * 0.3;
    this.peak = Math.max(this.peak, this.smoothed);
    if (this.smoothed > 1) {
      const rawEta = Math.max(0, (totalBytes - last.bytes) / this.smoothed);
      this.eta = this.eta === null ? rawEta : this.eta * 0.8 + rawEta * 0.2;
    }
    return { bytesPerSecond: this.smoothed, peak: this.peak, etaSeconds: this.eta, elapsedMs: this.elapsed() };
  }

  private elapsed() {
    return this.startedAt === null ? 0 : this.now() - this.startedAt;
  }
}

export function percentage(bytes: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (bytes / total) * 100));
}
