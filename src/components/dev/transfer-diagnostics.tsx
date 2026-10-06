"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { runMatrix, type MatrixRow } from "@/lib/benchmarks/loopback";
import type { BenchResult } from "@/lib/benchmarks/synthetic";
import { classifyThroughput } from "@/lib/diagnostics/stats";
import { formatBytes, formatSpeed } from "@/lib/files/format";
import type { TransferApi } from "@/hooks/use-transfer";
import type { TransferSession } from "@/lib/webrtc/connection-manager";
import { DEFAULT_TUNING, LEGACY_TUNING, type Tuning } from "@/lib/webrtc/tuning";
import { NearbyDiagnostics } from "./nearby-diagnostics";

/** Developer-only. Enable with ?debug=1 (or ?diag=1, NEXT_PUBLIC_DIAGNOSTICS=1, Shift+D). */
const MB = 1024 * 1024;
const KB = 1024;
const t = (chunk: number, high: number, low: number, win: number, poll = 15): Tuning => ({
  chunkSize: chunk * KB,
  highWater: high * MB,
  lowWater: low * MB,
  window: win * MB,
  pollMs: poll,
});

/** One variable changes per step so each delta is attributable. */
const MATRIX: Array<{ name: string; tuning: Tuning }> = [
  { name: "A legacy 128K · 1M/.25M · no win · 200ms", tuning: LEGACY_TUNING },
  { name: "B  + 15ms poll", tuning: { ...LEGACY_TUNING, pollMs: 15 } },
  { name: "C  + 8M/2M water", tuning: t(128, 8, 2, 0) },
  { name: "D  64K chunk, 8M/2M", tuning: t(64, 8, 2, 0) },
  { name: "E  256K chunk, 8M/2M", tuning: t(256, 8, 2, 0) },
  { name: "F  64K · 12M/3M (max valid)", tuning: t(64, 12, 3, 0) },
  { name: "G  default 64K · 4M/1M · 8M win", tuning: DEFAULT_TUNING },
  { name: "H  default + 32M win", tuning: { ...DEFAULT_TUNING, window: 32 * MB } },
];

const session = () => (window as unknown as { __origin?: TransferSession }).__origin;
const mbps = (n: number) => `${n.toFixed(1)} MB/s`;

function Section({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <section className="mt-2">
      <p className="text-signal">{title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-3">{k}</dt>
            <dd className="num break-all">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function TransferDiagnostics({ api }: { api: TransferApi }) {
  const flagged = useSyncExternalStore(
    () => () => {},
    () => {
      const q = new URLSearchParams(location.search);
      return process.env.NEXT_PUBLIC_DIAGNOSTICS === "1" || q.has("debug") || q.has("diag");
    },
    () => false,
  );
  const [toggled, setToggled] = useState(false);
  const [bench, setBench] = useState<Array<{ mb: number; r: BenchResult }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<MatrixRow[]>([]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === "D" && !(e.target instanceof HTMLInputElement)) setToggled((v) => !v);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);

  if (flagged === toggled) return null;
  const { m, metrics, diag } = api;
  const p = diag?.path;
  const live = m.phase === "connected" || m.phase === "completed";
  const avgFile = metrics.elapsedMs > 0 ? metrics.bytes / (metrics.elapsedMs / 1000) : 0;
  const lastSynth = diag?.lastBench ?? bench.at(-1)?.r ?? null;

  const runBench = async (mb: number) => {
    setBusy(`bench ${mb} MB`);
    setError(null);
    try {
      const r = await session()!.runBenchmark(mb);
      setBench((b) => [...b, { mb, r }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(null);
    }
  };

  const runLoopback = async () => {
    setBusy("loopback matrix");
    setError(null);
    setRows([]);
    try {
      await runMatrix(MATRIX, 64, (row) => setRows((r) => [...r, row]));
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(null);
    }
  };

  const btn = "rounded border border-white/15 px-2 py-1 hover:bg-white/10 disabled:opacity-40";

  return (
    <aside
      aria-label="Transfer debug"
      className="fixed bottom-3 left-3 z-50 max-h-[85dvh] w-[min(26rem,calc(100vw-1.5rem))] overflow-y-auto rounded-md border border-white/10 bg-black/90 p-3 font-mono text-[10.5px] leading-[1.5] text-ink-2 backdrop-blur"
    >
      <p className="text-foreground">TRANSFER DEBUG</p>

      <Section
        title="CONNECTION"
        rows={[
          ["state", `${m.phase} (${m.role ?? "—"})`],
          ["ICE", p?.iceState ?? diag?.iceState ?? "—"],
          ["candidate", p ? `${p.localType} → ${p.remoteType}` : "—"],
          ["transport", p?.protocol || "—"],
          ["route", (p?.route ?? "unknown").toUpperCase()],
          ["RTT", p?.rttMs != null ? `${p.rttMs.toFixed(0)} ms` : "—"],
          ["capacity", p?.availableOutKbps != null ? `${(p.availableOutKbps / 1000).toFixed(0)} Mbps` : "n/a (not reported)"],
          ["pkts lost", p?.packetsLost != null ? String(p.packetsLost) : "n/a"],
          ["platform", diag?.platform ?? "—"],
        ]}
      />
      <Section
        title="DATA CHANNEL"
        rows={[
          ["state", diag?.channelState ?? "—"],
          ["buffered", `${formatBytes(diag?.bufferedAmount ?? 0, 2)}`],
          ["high / low", diag ? `${formatBytes(diag.tuning.highWater)} / ${formatBytes(diag.tuning.lowWater)}` : "—"],
          ["messages", p ? `${p.dcMessagesSent} out · ${p.dcMessagesReceived} in` : "—"],
        ]}
      />
      <Section
        title="TRANSFER"
        rows={[
          ["chunk", diag?.chunkSize ? formatBytes(diag.chunkSize) : "—"],
          ["window", diag ? (diag.tuning.window ? formatBytes(diag.tuning.window) : "off") : "—"],
          ["in flight", formatBytes(diag?.inFlight ?? 0, 2)],
          ["speed", formatSpeed(metrics.bytesPerSecond)],
          ["average", formatSpeed(avgFile)],
          ["peak", formatSpeed(metrics.peakBytesPerSecond)],
          ["class", avgFile > 0 ? classifyThroughput(avgFile) : "—"],
          ["bytes", `${formatBytes(metrics.bytes, 1)} / ${formatBytes(metrics.totalBytes, 1)}`],
          ["file", diag?.currentFile ?? "—"],
          ["hash", diag?.hash ?? "—"],
          ["reconnects", String(diag?.reconnects ?? 0)],
        ]}
      />
      <Section
        title="CPU / MEMORY"
        rows={[
          ["loop lag", `${(diag?.loopLagMs ?? 0).toFixed(0)} ms`],
          ["JS heap", diag?.heapBytes != null ? formatBytes(diag.heapBytes, 0) : "n/a (Chrome only)"],
        ]}
      />

      <section className="mt-3 border-t border-white/10 pt-2">
        <p className="text-signal">NETWORK / WEBRTC TEST (synthetic, same channel)</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {[16, 32, 64, 256].map((mb) => (
            <button key={mb} className={btn} disabled={!!busy || !live} onClick={() => runBench(mb)}>
              {mb} MB
            </button>
          ))}
        </div>
        {!live && <p className="mt-1 text-ink-3">Connect the two devices first (idle, no transfer running).</p>}
        {bench.slice(-4).map(({ mb, r }, i) => (
          <p key={i} className="num mt-1">
            {mb} MB · {mbps(r.mbPerSec)} · {(r.ms / 1000).toFixed(2)}s · buf avg {formatBytes(r.avgBuffered, 1)}
          </p>
        ))}
        {lastSynth && avgFile > 0 && (
          <p className="mt-1 text-foreground">
            synthetic {mbps(lastSynth.mbPerSec)} vs photos {mbps(avgFile / 1e6)}
            {metrics.totalBytes < 64e6
              ? " · too small to compare (fixed costs dominate); send ≥ 64 MB"
              : lastSynth.mbPerSec > (avgFile / 1e6) * 1.5
                ? " → file pipeline is the limit"
                : " → network/WebRTC path is the limit"}
          </p>
        )}
      </section>

      <section className="mt-3 border-t border-white/10 pt-2">
        <p className="text-signal">LOOPBACK SELF-TEST (this page only, no radio)</p>
        <button className={`${btn} mt-1`} disabled={!!busy} onClick={runLoopback}>
          Run matrix (64 MB each)
        </button>
        {rows.map((r) => (
          <p key={r.name} className="num mt-1">
            {r.name}
            <br />
            synthetic {mbps(r.synthetic.mbPerSec)} · file {mbps(r.fileMBps)}
          </p>
        ))}
      </section>

      <NearbyDiagnostics />

      {busy && <p className="mt-2 text-foreground">running {busy}…</p>}
      {error && <p className="mt-2 text-destructive">{error}</p>}
    </aside>
  );
}
