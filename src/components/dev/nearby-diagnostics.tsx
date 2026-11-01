"use client";

import { useEffect, useState } from "react";
import { nearbyDebug, type NearbyDebug } from "@/lib/proximity/debug-store";
import { PROFILES } from "@/lib/proximity/modulation";

/** Developer-only Nearby readout (`?debug=proximity`). Polls a plain object at 4 Hz; the token is never shown. */
export function NearbyDiagnostics() {
  const [d, setD] = useState<NearbyDebug>(() => structuredClone(nearbyDebug));
  useEffect(() => {
    const t = setInterval(() => setD(structuredClone(nearbyDebug)), 250);
    return () => clearInterval(t);
  }, []);

  const s = d.trackSettings ?? {};
  const flag = (v: unknown) => (v === undefined ? "n/a" : v ? "on" : "off");
  const ok = (v: boolean | null) => (v === null ? "—" : v ? "✓" : "✕");
  const minDb = -120;
  const maxDb = -20;

  return (
    <section className="mt-3 border-t border-white/10 pt-2">
      <p className="text-signal">PROXIMITY ({d.role ?? "idle"})</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3">
        <dt className="text-ink-3">context rate</dt>
        <dd className="num">{d.contextRate ?? "—"}</dd>
        <dt className="text-ink-3">capture rate</dt>
        <dd className="num">{d.captureRate ?? "not reported"}</dd>
        <dt className="text-ink-3">channels</dt>
        <dd className="num">{d.channels ?? "—"}</dd>
        <dt className="text-ink-3">EC / NS / AGC</dt>
        <dd>
          {flag(s.echoCancellation)} / {flag(s.noiseSuppression)} / {flag(s.autoGainControl)}
        </dd>
        <dt className="text-ink-3">mic</dt>
        <dd className="break-all">{d.deviceLabel || "—"}</dd>
        <dt className="text-ink-3">profiles</dt>
        <dd>{d.profiles.join(", ") || "—"}</dd>
        <dt className="text-ink-3">capability</dt>
        <dd className="break-all">{d.capability}</dd>
        {d.broadcast && (
          <>
            <dt className="text-ink-3">broadcast</dt>
            <dd className="num">
              {d.broadcast.profile} · level {d.broadcast.amplitude} · {d.broadcast.packetMs} ms × ≤{d.broadcast.repeats}
            </dd>
          </>
        )}
      </dl>

      {d.decoders.map((dec) => {
        const profile = PROFILES.find((p) => p.id === dec.profile);
        return (
          <div key={dec.profile} className="mt-2">
            <p className="text-ink-3">{dec.profile}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3">
              {profile?.tones.map((hz, i) => (
                <div key={hz} className="contents">
                  <dt className="text-ink-3">{(hz / 1000).toFixed(2)}k</dt>
                  <dd className="num">
                    {dec.toneDb[i].toFixed(0)} dB {dec.toneDb[i] > dec.noiseDb + 10 ? "✓" : "✕"}
                  </dd>
                </div>
              ))}
              <dt className="text-ink-3">noise floor</dt>
              <dd className="num">{dec.noiseDb.toFixed(0)} dB</dd>
              <dt className="text-ink-3">SNR</dt>
              <dd className="num">{dec.snrDb.toFixed(0)} dB</dd>
            </dl>
          </div>
        );
      })}

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3">
        <dt className="text-ink-3">preamble</dt>
        <dd>{ok(d.stages.preamble)}</dd>
        <dt className="text-ink-3">sync</dt>
        <dd>{ok(d.stages.sync)}</dd>
        <dt className="text-ink-3">payload</dt>
        <dd>{ok(d.stages.payload)}</dd>
        <dt className="text-ink-3">CRC</dt>
        <dd>{ok(d.stages.crc)}</dd>
        <dt className="text-ink-3">session</dt>
        <dd>{d.stages.session}</dd>
        {Object.entries(d.timings).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-3">t {k}</dt>
            <dd className="num">{v} ms</dd>
          </div>
        ))}
      </dl>

      {d.spectrum.length > 0 && (
        <div className="mt-2">
          <div className="flex h-16 items-end gap-px" aria-label="Spectrum 1 to 6 kHz">
            {d.spectrum.map((b) => (
              <div
                key={b.hz}
                title={`${b.hz} Hz ${b.db.toFixed(0)} dB`}
                className="flex-1 bg-white/60"
                style={{ height: `${Math.max(2, ((b.db - minDb) / (maxDb - minDb)) * 100)}%` }}
              />
            ))}
          </div>
          <div className="flex justify-between text-ink-3">
            <span>{(d.spectrum[0].hz / 1000).toFixed(0)} kHz</span>
            <span>{(d.spectrum[d.spectrum.length - 1].hz / 1000).toFixed(1)} kHz</span>
          </div>
        </div>
      )}
    </section>
  );
}
