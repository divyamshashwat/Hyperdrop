import { UltrasonicDecoder, bandLevel, toDb } from "./decoder";
import { debugEnabled, nearbyDebug, resetNearbyDebug } from "./debug-store";
import { profilesForCapture } from "./modulation";
import { tokenToHex } from "./protocol";

export type NearbyStatus =
  | "starting"
  | "listening"
  | "signal" // a preamble was heard
  | "validating" // a packet decoded; asking the server
  | "paired"
  | "unsupported"
  | "denied"
  | "no-mic"
  | "mic-busy"
  | "timeout"
  | "error";

export type UnsupportedReason = "insecure" | "no-audio" | "sample-rate" | "filtered";

export interface NearbyState {
  status: NearbyStatus;
  reason?: UnsupportedReason;
  /** True when the capture device looks like Bluetooth/headphones (often strips high frequencies). */
  externalMic?: boolean;
}

const LISTEN_TIMEOUT_MS = 20_000;
const START_WATCHDOG_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}
const CAPABILITY_WINDOW_S = 0.4;

/**
 * The phone's ear. Asks for the microphone only when the user taps, measures
 * what the hardware actually delivers, refuses (honestly) when the ultrasonic
 * band can't be heard, decodes locally, and switches the microphone off the
 * moment the server confirms the token. Audio never leaves the device.
 */
export class NearbyListener {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private nodes: AudioNode[] = [];
  private decoders: UltrasonicDecoder[] = [];
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private probe: Float32Array[] = [];
  private probeLen = 0;
  private checked = false;
  private busy = false;
  private stopped = false;
  private last: Float32Array = new Float32Array(0);
  private t0 = 0;

  constructor(
    private h: {
      onState(s: NearbyState): void;
      /** Ask the server: is this token live? Resolves true once the device has joined the room. */
      onToken(tokenHex: string): Promise<boolean>;
    },
  ) {}

  static environmentReason(): UnsupportedReason | null {
    if (typeof window === "undefined") return "no-audio";
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return "insecure";
    if (!("AudioContext" in window)) return "no-audio";
    return null;
  }

  /** Call from the click handler: microphone permission is only ever requested here. */
  async start() {
    this.t0 = performance.now();
    resetNearbyDebug("listener");
    const env = NearbyListener.environmentReason();
    if (env) {
      nearbyDebug.capability = env;
      return this.finish({ status: "unsupported", reason: env });
    }
    this.h.onState({ status: "starting" });
    // Never sit on "Getting ready…": if setup hasn't reached listening in 15 s, say so.
    this.watchdog = setTimeout(() => {
      nearbyDebug.capability = `start stalled at: ${nearbyDebug.capability}`;
      this.finish({ status: "error" });
    }, START_WATCHDOG_MS);
    nearbyDebug.capability = "requesting microphone";
    // AudioContext created inside the gesture so iOS lets it run.
    this.ctx = new AudioContext();
    void this.ctx.resume();

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === "OverconstrainedError") {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e2) {
          return this.fail(e2);
        }
      } else {
        return this.fail(e);
      }
    }
    if (this.stopped) return this.cleanup();

    nearbyDebug.capability = "microphone granted";
    const track = this.stream.getAudioTracks()[0];
    const settings = track?.getSettings?.() ?? {};
    const rate = this.ctx.sampleRate; // what we actually process at, not what we asked for
    nearbyDebug.contextRate = rate;
    nearbyDebug.captureRate = typeof settings.sampleRate === "number" ? settings.sampleRate : null;
    nearbyDebug.channels = typeof settings.channelCount === "number" ? settings.channelCount : null;
    nearbyDebug.trackSettings = settings as Record<string, unknown>;
    nearbyDebug.deviceLabel = track?.label ?? "";
    nearbyDebug.timings.micReady = Math.round(performance.now() - this.t0);
    const externalMic = /bluetooth|airpods|headset|hands-free|buds/i.test(track?.label ?? "");

    const profiles = profilesForCapture(Math.min(rate, nearbyDebug.captureRate ?? rate));
    nearbyDebug.profiles = profiles.map((p) => p.id);
    if (!profiles.length) {
      nearbyDebug.capability = `capture rate ${rate} Hz is too low`;
      return this.finish({ status: "unsupported", reason: "sample-rate", externalMic });
    }
    this.decoders = profiles.map((p) => new UltrasonicDecoder(p, rate));

    const source = this.ctx.createMediaStreamSource(this.stream);
    const sink = this.ctx.createGain();
    sink.gain.value = 0; // keeps the graph pulled without making any sound
    sink.connect(this.ctx.destination);
    this.nodes.push(source, sink);
    try {
      // A real same-origin file (iOS WebKit can hang on blob: worklet URLs), and never wait more than 2 s.
      if (!this.ctx.audioWorklet) throw new Error("no AudioWorklet");
      nearbyDebug.capability = "loading audio worklet";
      await withTimeout(this.ctx.audioWorklet.addModule("/nearby-tap.js"), 2000);
      const tap = new AudioWorkletNode(this.ctx, "nearby-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      tap.port.onmessage = (e: MessageEvent<Float32Array>) => this.feed(e.data);
      source.connect(tap).connect(sink);
      this.nodes.push(tap);
      nearbyDebug.capability = "listening (AudioWorklet)";
    } catch {
      nearbyDebug.capability = "listening (ScriptProcessor fallback)";
      // Older engines: ScriptProcessor is deprecated but still widely available.
      const sp = this.ctx.createScriptProcessor(2048, 1, 1);
      sp.onaudioprocess = (e) => this.feed(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(sp).connect(sink);
      this.nodes.push(sp);
    }
    if (this.stopped) return this.cleanup();

    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.h.onState({ status: "listening", externalMic });
    this.timeout = setTimeout(() => this.finish({ status: "timeout" }), LISTEN_TIMEOUT_MS);
    if (debugEnabled()) this.statsTimer = setInterval(() => this.publishStats(), 200);
  }

  stop() {
    this.stopped = true;
    this.cleanup();
  }

  private feed(chunk: Float32Array) {
    if (this.stopped || !this.ctx) return;
    this.last = chunk;
    if (!this.checked) this.capabilityProbe(chunk);
    if (this.busy) return; // a token is being validated; don't stack requests
    for (const d of this.decoders) {
      for (const ev of d.push(chunk)) {
        if (ev.type === "signal") {
          nearbyDebug.timings.signal ??= Math.round(performance.now() - this.t0);
          this.h.onState({ status: "signal" });
        } else if (ev.type === "preamble") {
          nearbyDebug.stages.preamble = true;
          nearbyDebug.timings.preamble ??= Math.round(performance.now() - this.t0);
        } else if (ev.type === "crc-failed" || ev.type === "sync-failed") {
          nearbyDebug.stages.sync = ev.type === "crc-failed";
          nearbyDebug.stages.crc = ev.type === "crc-failed" ? false : null;
        } else if (ev.type === "packet") {
          nearbyDebug.stages = { preamble: true, sync: true, payload: true, crc: true, session: "—" };
          nearbyDebug.timings.decoded = Math.round(performance.now() - this.t0);
          void this.validate(tokenToHex(ev.packet.payload.token));
          return;
        }
      }
    }
  }

  /**
   * Before trusting "Listening…", check the high band isn't simply cut off by the
   * capture path (some processing low-passes around 16-20 kHz). If audible-band
   * sound is present but the carrier band is digital silence, Nearby can't work here.
   */
  private capabilityProbe(chunk: Float32Array) {
    this.probe.push(chunk);
    this.probeLen += chunk.length;
    if (!this.ctx || this.probeLen < this.ctx.sampleRate * CAPABILITY_WINDOW_S) return;
    this.checked = true;
    const all = new Float32Array(this.probeLen);
    let o = 0;
    for (const c of this.probe) {
      all.set(c, o);
      o += c.length;
    }
    this.probe = [];
    const rate = this.ctx.sampleRate;
    const tones = this.decoders.flatMap((d) => [...d.profile.tones]);
    const high = bandLevel(all, rate, tones);
    const low = bandLevel(all, rate, [500, 1000, 2000, 4000]);
    nearbyDebug.capability = `band ${toDb(high).toFixed(0)} dB vs audible ${toDb(low).toFixed(0)} dB`;
    if (low > 1e-8 && high < 1e-13) {
      nearbyDebug.capability += " → high band filtered";
      this.finish({ status: "unsupported", reason: "filtered" });
    }
  }

  private async validate(tokenHex: string) {
    this.busy = true;
    this.h.onState({ status: "validating" });
    let ok = false;
    try {
      ok = await this.h.onToken(tokenHex);
    } catch {
      ok = false;
    }
    nearbyDebug.stages.session = ok ? "VALID" : "INVALID";
    nearbyDebug.timings.validated = Math.round(performance.now() - this.t0);
    if (ok) return this.finish({ status: "paired" }); // microphone off right now
    // Stale or foreign token: keep listening for the next repeat.
    this.busy = false;
    if (!this.stopped) this.h.onState({ status: "listening" });
  }

  private fail(e: unknown) {
    const name = (e as DOMException)?.name;
    const status: NearbyStatus =
      name === "NotAllowedError" || name === "SecurityError"
        ? "denied"
        : name === "NotFoundError"
          ? "no-mic"
          : name === "NotReadableError"
            ? "mic-busy"
            : "error";
    nearbyDebug.capability = `getUserMedia: ${name ?? "error"}`;
    this.finish({ status });
  }

  private finish(s: NearbyState) {
    this.cleanup();
    this.h.onState(s);
  }

  private publishStats() {
    nearbyDebug.decoders = this.decoders.map((d) => ({ ...d.getStats() }));
    const rate = this.ctx?.sampleRate ?? 48000;
    const spectrum: Array<{ hz: number; db: number }> = [];
    for (let hz = 18000; hz <= Math.min(23750, rate / 2 - 250); hz += 250) {
      spectrum.push({ hz, db: toDb(bandLevel(this.last, rate, [hz])) });
    }
    nearbyDebug.spectrum = spectrum;
  }

  /** Every path ends here: tracks stopped, nodes disconnected, context closed, timers cleared. */
  private cleanup() {
    if (this.timeout) clearTimeout(this.timeout);
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.timeout = this.watchdog = this.statsTimer = null;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
      if (n instanceof AudioWorkletNode) n.port.onmessage = null;
      if (n instanceof ScriptProcessorNode) n.onaudioprocess = null;
    }
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx) void this.ctx.close().catch(() => {});
    this.ctx = null;
    this.decoders = [];
    this.probe = [];
    this.last = new Float32Array(0);
  }
}
