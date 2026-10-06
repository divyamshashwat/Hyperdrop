"use client";

import { useEffect, useRef, useState } from "react";
import { ToneDecoder, bandLevel, toDb } from "@/lib/proximity/decoder";
import { openMicTap, type MicTap } from "@/lib/proximity/mic-tap";
import { DEFAULT_AMPLITUDE, chooseOutputProfile, profilesForCapture, renderTone } from "@/lib/proximity/modulation";
import { PROTOCOL_VERSION, tokenToHex } from "@/lib/proximity/protocol";
import { generateNearbySignal } from "@/lib/proximity/encoder";

const TEST_FREQS = [1800, 2400, 3000, 3600, 4200, 4800, 6000];

/**
 * Hardware calibration for Nearby. Run "Emit" on the computer and "Listen" on
 * the phone, one frequency at a time, at a few levels. The results decide
 * which carriers ship, not the theory in modulation.ts.
 */
export function ProximityLab() {
  const [env, setEnv] = useState({ secure: false, mic: false, ua: "" });
  useEffect(() => {
    const t = setTimeout(
      () =>
        setEnv({ secure: window.isSecureContext, mic: !!navigator.mediaDevices?.getUserMedia, ua: navigator.userAgent }),
      0,
    );
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="space-y-12 text-[15px]">
      <div>
        <h1 className="t-title">Nearby calibration</h1>
        <p className="t-meta mt-3">
          Developer tool. Emit on the computer, listen on the phone, and record which frequencies survive. Keep the level as
          low as works.
        </p>
        <p className="t-small mt-3 break-all">
          secure context {env.secure ? "yes" : "NO (microphone blocked)"} · getUserMedia {env.mic ? "yes" : "no"} · {env.ua}
        </p>
      </div>
      <Emit />
      <Listen ua={env.ua} />
    </div>
  );
}

function Emit() {
  const ctx = useRef<AudioContext | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [level, setLevel] = useState(DEFAULT_AMPLITUDE);
  const [playing, setPlaying] = useState<string | null>(null);
  const [testToken, setTestToken] = useState<string | null>(null);

  const ensure = () => {
    ctx.current ??= new AudioContext();
    void ctx.current.resume();
    setRate(ctx.current.sampleRate);
    return ctx.current;
  };

  const play = (buf: AudioBuffer, label: string, loops = 1) => {
    const c = ensure();
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = loops > 1;
    src.connect(c.destination);
    src.start();
    if (loops > 1) src.stop(c.currentTime + buf.duration * loops);
    setPlaying(label);
    src.onended = () => setPlaying(null);
  };

  const tone = (hz: number) => {
    const c = ensure();
    const pcm = renderTone(hz, c.sampleRate, 2.5, level);
    const buf = c.createBuffer(1, pcm.length, c.sampleRate);
    buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    play(buf, `${hz} Hz`);
  };

  const packet = () => {
    const c = ensure();
    const profile = chooseOutputProfile(c.sampleRate);
    if (!profile) return setPlaying(`no profile at ${c.sampleRate} Hz`);
    const r = new Uint32Array(1);
    crypto.getRandomValues(r);
    setTestToken(tokenToHex(r[0]));
    play(generateNearbySignal(c, { version: PROTOCOL_VERSION, flags: 0, token: r[0] }, profile, level), `packet ${profile.id}`, 3);
  };

  /** Render the real AudioBuffer offline at this browser's rates, add noise, decode. No speaker, no mic. */
  const selfTest = async () => {
    const out: string[] = [];
    for (const sr of [48000, 44100]) {
      const profile = chooseOutputProfile(sr);
      if (!profile) continue;
      const r = new Uint32Array(1);
      crypto.getRandomValues(r);
      const off = new OfflineAudioContext(1, sr * 3, sr);
      const buf = generateNearbySignal(off, { version: PROTOCOL_VERSION, flags: 0, token: r[0] }, profile, level);
      const src = off.createBufferSource();
      src.buffer = buf;
      src.connect(off.destination);
      src.start(0.15);
      const rendered = (await off.startRendering()).getChannelData(0);
      const x = new Float32Array(rendered.length);
      for (let i = 0; i < x.length; i++) x[i] = rendered[i] * 0.3 + (Math.random() - 0.5) * 0.02;
      const dec = new ToneDecoder(profile, sr);
      const got = dec.push(x).find((e) => e.type === "packet");
      const ok = !!got && got.type === "packet" && got.packet.payload.token === r[0];
      out.push(`${sr} Hz ${profile.id}: ${ok ? "decoded ✓" : "FAILED ✕"}`);
    }
    setPlaying(`self-test · ${out.join(" · ")}`);
  };

  const nyquist = (rate ?? 48000) / 2;

  return (
    <section>
      <h2 className="text-[19px] font-semibold tracking-[-0.02em]">Emit (computer)</h2>
      <p className="t-small mt-1">Output rate {rate ?? "— (tap anything)"} Hz</p>
      <label className="t-meta mt-4 flex items-center gap-3">
        Level {level.toFixed(2)}
        <input type="range" min={0.02} max={0.4} step={0.01} value={level} onChange={(e) => setLevel(Number(e.target.value))} className="flex-1" />
      </label>
      <div className="mt-4 grid grid-cols-4 gap-2">
        {TEST_FREQS.map((hz) => (
          <button
            key={hz}
            onClick={() => tone(hz)}
            disabled={hz >= nyquist * 0.97}
            className="h-11 rounded-[10px] bg-white/[0.07] transition-colors hover:bg-white/[0.12] disabled:opacity-30"
          >
            {(hz / 1000).toFixed(1)}k
          </button>
        ))}
        <button onClick={packet} className="col-span-4 h-11 rounded-[10px] bg-[#efeeea] text-[#0b0b0a] transition-colors hover:bg-white">
          Emit test packet ×3
        </button>
        <button onClick={selfTest} className="col-span-4 h-11 rounded-[10px] bg-white/[0.07] transition-colors hover:bg-white/[0.12]">
          Digital self-test (no speaker, no mic)
        </button>
      </div>
      <p className="t-small mt-3">
        {playing ? `Playing ${playing}` : "Idle"}
        {testToken && ` · test token ${testToken}`}
      </p>
    </section>
  );
}

function Listen({ ua }: { ua: string }) {
  const tap = useRef<MicTap | null>(null);
  const buf = useRef<Float32Array[]>([]);
  const decoders = useRef<ToneDecoder[]>([]);
  const preambleAt = useRef(0);
  const [info, setInfo] = useState<{ rate: number; settings: MediaTrackSettings; label: string } | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [heard, setHeard] = useState<Record<number, boolean>>({});
  const [decoded, setDecoded] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => tap.current?.close(), []);

  const start = async () => {
    setError(null);
    try {
      const t = await openMicTap((x) => {
        buf.current.push(x);
        for (const d of decoders.current) {
          for (const ev of d.push(x)) {
            if (ev.type === "preamble") preambleAt.current = performance.now();
            if (ev.type === "packet") {
              const ms = Math.round(performance.now() - preambleAt.current);
              setDecoded((l) => [`${tokenToHex(ev.packet.payload.token)} · ${ev.profile} · ${ev.packet.corrections} fixes · ${ms} ms after preamble`, ...l].slice(0, 6));
            }
          }
        }
      });
      tap.current = t;
      decoders.current = profilesForCapture(t.ctx.sampleRate).map((p) => new ToneDecoder(p, t.ctx.sampleRate));
      setInfo({ rate: t.ctx.sampleRate, settings: t.settings, label: t.label });
    } catch (e) {
      setError((e as DOMException)?.name ?? "failed");
    }
  };

  const stop = () => {
    tap.current?.close();
    tap.current = null;
    setInfo(null);
  };

  // Measure the last ~250 ms at each test frequency, 4x a second.
  useEffect(() => {
    if (!info) return;
    const t = setInterval(() => {
      const chunks = buf.current.splice(0);
      const n = chunks.reduce((s, c) => s + c.length, 0);
      if (!n) return;
      const all = new Float32Array(n);
      let o = 0;
      for (const c of chunks) {
        all.set(c, o);
        o += c.length;
      }
      const db = TEST_FREQS.map((hz) => (hz < info.rate / 2 ? toDb(bandLevel(all, info.rate, [hz])) : -140));
      const sorted = [...db].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      setLevels(db);
      setHeard((h) => {
        const next = { ...h };
        TEST_FREQS.forEach((hz, i) => {
          if (db[i] > median + 15 && db[i] > -100) next[hz] = true;
        });
        return next;
      });
    }, 250);
    return () => clearInterval(t);
  }, [info]);

  const row = info
    ? `${ua.match(/iPhone OS [\d_]+|Android [\d.]+|Windows NT [\d.]+|Mac OS X [\d_]+/)?.[0] ?? "device"} | ctx ${info.rate} | mic ${info.settings.sampleRate ?? "?"} | ${TEST_FREQS.map((hz) => `${(hz / 1000).toFixed(1)}${heard[hz] ? "✓" : "✕"}`).join(" ")}`
    : "";

  return (
    <section>
      <h2 className="text-[19px] font-semibold tracking-[-0.02em]">Listen (phone)</h2>
      <div className="mt-4 flex gap-2">
        <button onClick={info ? stop : start} className="h-11 flex-1 rounded-[10px] bg-[#efeeea] text-[#0b0b0a] transition-colors hover:bg-white">
          {info ? "Stop microphone" : "Start microphone"}
        </button>
        <button onClick={() => { setHeard({}); setDecoded([]); }} className="h-11 rounded-[10px] bg-white/[0.07] px-4 hover:bg-white/[0.12]">
          Reset
        </button>
      </div>
      {error && <p className="mt-3 text-destructive">Microphone: {error}</p>}
      {info && (
        <>
          <p className="t-small mt-3 break-all">
            context {info.rate} Hz · mic {String(info.settings.sampleRate ?? "not reported")} · EC {String(info.settings.echoCancellation)} · NS{" "}
            {String(info.settings.noiseSuppression)} · AGC {String(info.settings.autoGainControl)} · {info.label}
          </p>
          <table className="num mt-4 w-full text-left">
            <tbody>
              {TEST_FREQS.map((hz, i) => (
                <tr key={hz} className="border-t border-white/[0.06]">
                  <td className="py-1.5">{(hz / 1000).toFixed(1)} kHz</td>
                  <td>{levels[i] !== undefined ? `${levels[i].toFixed(0)} dB` : "—"}</td>
                  <td>{hz >= info.rate / 2 ? "above Nyquist" : heard[hz] ? "detected" : "not detected"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="t-small mt-4">Matrix row (copy into the compatibility table):</p>
          <p className="mt-1 break-all font-mono text-[12px]">{row}</p>
          <p className="t-small mt-4">Decoded packets:</p>
          {decoded.length ? decoded.map((d, i) => <p key={i} className="font-mono text-[12px]">{d}</p>) : <p className="t-small">none yet</p>}
        </>
      )}
    </section>
  );
}
