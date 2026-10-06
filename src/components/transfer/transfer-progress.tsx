"use client";

import { useEffect, useMemo, useState } from "react";
import { formatBytes, formatEta, formatSpeed, pluralPhotos } from "@/lib/files/format";
import type { FsDir } from "@/lib/files/sink";
import { detectCapabilities } from "@/lib/session/capabilities";
import type { MetricsSnapshot } from "@/lib/transfer/metrics";
import type { Machine } from "@/lib/webrtc/connection-state";
import { cn } from "@/lib/utils";
import { ConfirmCancel } from "./confirm-cancel";
import { Dots, RelayNotice, Screen, StatusLine } from "./ui";

const QUIET_AFTER_MS = 8000;

/**
 * One big number and one line. After a few steady seconds everything that
 * isn't progress recedes, so the phone can be put down.
 */
export function TransferProgress({
  m,
  metrics,
  awake,
  dest,
  onCancel,
}: {
  m: Machine;
  metrics: MetricsSnapshot;
  awake: boolean;
  dest: FsDir | null;
  onCancel: () => void;
}) {
  const receiving = m.role === "receiver";
  const reconnecting = m.phase === "reconnecting";
  const finalizing = m.phase === "finalizing";
  const total = metrics.totalBytes || m.summary?.totalBytes || 0;
  const count = metrics.fileCount || m.summary?.fileCount || 0;
  const pct = finalizing ? 100 : Math.min(100, Math.floor(metrics.percentage));
  const bytes = finalizing ? total : metrics.bytes;

  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQuiet(true), QUIET_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  const caps = useMemo(() => detectCapabilities(), []);
  const recede = cn("transition-opacity duration-1000", quiet && !reconnecting ? "opacity-45" : "opacity-100");

  const heading = reconnecting
    ? "Reconnecting"
    : finalizing
      ? "Verifying originals"
      : `${receiving ? "Receiving" : "Sending"} ${pluralPhotos(count)}`;

  return (
    <Screen label="Transfer progress" actions={<div className={cn("flex justify-center", recede)}><ConfirmCancel onConfirm={onCancel} label={receiving ? "Stop receiving" : "Cancel transfer"} /></div>}>
      <p className={cn("t-meta", recede)} aria-live="polite">
        {heading}
        {(reconnecting || finalizing) && <Dots />}
      </p>

      <p className="t-figure mt-4" aria-hidden="true">
        {pct}
        <span className="ml-1 text-[0.32em] font-normal tracking-normal text-ink-3">%</span>
      </p>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={`${heading}, ${pct} percent`}
        className="mt-7 h-[3px] w-full overflow-hidden rounded-[2px] bg-white/[0.09]"
      >
        <div
          className="h-full origin-left bg-[#efeeea] transition-transform duration-300 ease-[var(--ease-out)]"
          style={{ transform: `scaleX(${pct / 100})` }}
        />
      </div>

      <div className="num mt-4 flex items-baseline justify-between text-[15px]">
        <span className="text-foreground">
          {formatBytes(bytes, 2)} <span className="text-ink-3">of {formatBytes(total, 2)}</span>
        </span>
        <span className="text-muted-foreground">
          {reconnecting ? "Paused" : finalizing ? "" : formatSpeed(metrics.bytesPerSecond)}
        </span>
      </div>
      {!reconnecting && !finalizing && <p className="t-meta num mt-1 text-right">{formatEta(metrics.etaSeconds)}</p>}
      {m.resumedFrom !== null && !reconnecting && <p className="t-meta mt-3">Resumed from {m.resumedFrom}%.</p>}

      {metrics.currentFile && !finalizing && <p className="mt-8 truncate text-[15px] text-muted-foreground">{metrics.currentFile}</p>}

      <div className={cn("mt-8 space-y-1", recede)}>
        <StatusLine route={m.route} peer={m.peerLabel} role={m.role} />
        {m.route === "relayed" && <RelayNotice />}
        {receiving && dest && <p className="t-small">Writing straight into {dest.name}.</p>}
        {!awake && !finalizing && <p className="t-small">Keep {caps.ios ? "Safari" : "this page"} open until it finishes.</p>}
      </div>
    </Screen>
  );
}
