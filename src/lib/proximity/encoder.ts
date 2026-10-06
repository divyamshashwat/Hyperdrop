import { nearbyDebug, resetNearbyDebug } from "./debug-store";
import { DEFAULT_AMPLITUDE, GAP_MS, chooseOutputProfile, renderSymbols, type FrequencyProfile } from "./modulation";
import { PROTOCOL_VERSION, encodePacket, hexToToken, type PairingPayload } from "./protocol";

/** PairingPayload -> AudioBuffer (one packet followed by a short silence). */
export function generateNearbySignal(
  ctx: BaseAudioContext,
  payload: PairingPayload,
  profile: FrequencyProfile,
  amplitude = DEFAULT_AMPLITUDE,
): AudioBuffer {
  const pcm = renderSymbols(encodePacket(payload), profile, ctx.sampleRate, amplitude, GAP_MS);
  const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
  buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
  return buf;
}

export type BroadcastState = "off" | "on" | "ended" | "unsupported";

const MAX_BROADCAST_MS = 15_000;

/**
 * The receiver's transmitter. Plays the same short packet on a loop for at most
 * 15 s (about four packets), behind smooth gain ramps, then stops on its own. Stops immediately when
 * told (a phone joined, the user cancelled, the page went away).
 */
export class NearbyBroadcaster {
  private ctx: AudioContext | null = null;
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  profile: FrequencyProfile | null = null;

  constructor(private onState: (s: BroadcastState) => void) {}

  static supported(): boolean {
    return typeof window !== "undefined" && "AudioContext" in window;
  }

  /**
   * Must run synchronously inside the click (user activation) so the browser
   * lets audio start. Picks the profile from the rate the output ACTUALLY runs at.
   */
  prepare(): boolean {
    if (!NearbyBroadcaster.supported()) return false;
    this.stop(false);
    this.ctx = new AudioContext(); // no forced sampleRate: we read what the hardware gives us
    void this.ctx.resume();
    this.profile = chooseOutputProfile(this.ctx.sampleRate);
    resetNearbyDebug("broadcaster");
    nearbyDebug.contextRate = this.ctx.sampleRate;
    nearbyDebug.capability = this.profile ? `transmit ${this.profile.id}` : "output rate too low for Nearby";
    if (!this.profile) {
      this.stop(false);
      this.onState("unsupported");
      return false;
    }
    return true;
  }

  play(tokenHex: string, amplitude = levelOverride() ?? DEFAULT_AMPLITUDE) {
    const ctx = this.ctx;
    if (!ctx || !this.profile) return;
    const buffer = generateNearbySignal(ctx, { version: PROTOCOL_VERSION, flags: 0, token: hexToToken(tokenHex) }, this.profile, amplitude);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.05);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(gain).connect(ctx.destination);
    src.start();
    this.src = src;
    this.gain = gain;
    nearbyDebug.broadcast = {
      profile: this.profile.id,
      amplitude,
      packetMs: Math.round((buffer.length / ctx.sampleRate) * 1000),
      repeats: Math.floor(MAX_BROADCAST_MS / ((buffer.length / ctx.sampleRate) * 1000)),
    };
    this.onState("on");
    this.timer = setTimeout(() => this.stop(true), MAX_BROADCAST_MS);
  }

  /** Fade out (no click), then release the audio device. */
  stop(ended = false) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ctx = this.ctx;
    const gain = this.gain;
    const src = this.src;
    this.ctx = this.src = this.gain = null;
    if (ctx && gain && src) {
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + 0.04);
      try {
        src.stop(t + 0.05);
      } catch {
        /* already stopped */
      }
      setTimeout(() => void ctx.close().catch(() => {}), 120);
    } else if (ctx) {
      void ctx.close().catch(() => {});
    }
    if (src) this.onState(ended ? "ended" : "off");
  }
}

/** `?nearbyLevel=0.1` lets calibration find the lowest reliable level without a rebuild. */
function levelOverride(): number | null {
  if (typeof location === "undefined") return null;
  const v = Number(new URLSearchParams(location.search).get("nearbyLevel"));
  return Number.isFinite(v) && v > 0 && v <= 0.5 ? v : null;
}
