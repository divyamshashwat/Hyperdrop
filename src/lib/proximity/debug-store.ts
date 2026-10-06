import type { DecoderStats } from "./decoder";

/**
 * Developer-only view of the Nearby pipeline (`?debug=proximity`). A plain
 * mutable object the audio code writes at a few Hz; React never sees audio frames.
 * The token itself is never stored here.
 */
export interface NearbyDebug {
  role: "listener" | "broadcaster" | null;
  captureRate: number | null;
  contextRate: number | null;
  channels: number | null;
  trackSettings: Record<string, unknown> | null;
  deviceLabel: string;
  profiles: string[];
  decoders: DecoderStats[];
  spectrum: Array<{ hz: number; db: number }>;
  stages: { preamble: boolean; sync: boolean; payload: boolean; crc: boolean | null; session: "—" | "VALID" | "INVALID" };
  timings: Record<string, number>;
  capability: string;
  broadcast: { profile: string; amplitude: number; packetMs: number; repeats: number } | null;
}

export const nearbyDebug: NearbyDebug = {
  role: null,
  captureRate: null,
  contextRate: null,
  channels: null,
  trackSettings: null,
  deviceLabel: "",
  profiles: [],
  decoders: [],
  spectrum: [],
  stages: { preamble: false, sync: false, payload: false, crc: null, session: "—" },
  timings: {},
  capability: "—",
  broadcast: null,
};

export function resetNearbyDebug(role: NearbyDebug["role"]) {
  Object.assign(nearbyDebug, {
    role,
    captureRate: null,
    contextRate: null,
    channels: null,
    trackSettings: null,
    deviceLabel: "",
    profiles: [],
    decoders: [],
    spectrum: [],
    stages: { preamble: false, sync: false, payload: false, crc: null, session: "—" },
    timings: {},
    capability: "—",
    broadcast: null,
  });
}

export const debugEnabled = () =>
  typeof location !== "undefined" && /(^|[?&])debug=(1|proximity)(&|$)|(^|[?&])diag/.test(location.search.slice(1));
