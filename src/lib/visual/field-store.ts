import type { Phase } from "../webrtc/connection-state";

/**
 * A plain mutable object shared between the app and the WebGL canvas. The
 * shader reads it every frame; React never re-renders for animation. Metrics
 * arrive at ~8 Hz from the session (already throttled), not per chunk.
 */
export enum FieldMode {
  Idle = 0,
  Connecting = 1,
  Connected = 2,
  Sending = 3,
  Completing = 4,
  Complete = 5,
  Error = 6,
  /** Receiver is ready and a single node is waiting for its counterpart. */
  Waiting = 7,
}

export interface FieldStore {
  mode: FieldMode;
  /** 0..1 share of bytes transferred. */
  progress: number;
  /** 0..1, throughput relative to a fast (≈30 MB/s) link. */
  speed: number;
  /** performance.now() timestamps of one-shot events, or -1. */
  pulseAt: number;
  errorAt: number;
  /** -1..1 pointer for a very slight parallax. */
  pointer: [number, number];
  /** On a portrait screen the bottom node is always "this device": receivers see data arrive downward. */
  receiver: boolean;
  /** Nearby: 0 off, 1 listening (soft field around this device), 2 signal heard, 3 locked onto a packet. */
  proximity: 0 | 1 | 2 | 3;
  /** performance.now() of the last "signal heard" moment, or -1. */
  detectAt: number;
}

export const field: FieldStore = {
  mode: FieldMode.Idle,
  progress: 0,
  speed: 0,
  pulseAt: -1,
  errorAt: -1,
  pointer: [0, 0],
  receiver: false,
  proximity: 0,
  detectAt: -1,
};

export function setFieldProximity(level: FieldStore["proximity"]) {
  if (level >= 2 && field.proximity < 2) field.detectAt = typeof performance === "undefined" ? 0 : performance.now();
  field.proximity = level;
}

export function modeForPhase(phase: Phase): FieldMode {
  switch (phase) {
    case "creating-session":
    case "waiting-for-peer":
      return FieldMode.Waiting;
    case "pairing":
    case "connecting":
    case "reconnecting":
      return FieldMode.Connecting;
    case "connected":
    case "awaiting-acceptance":
      return FieldMode.Connected;
    case "sending":
    case "receiving":
      return FieldMode.Sending;
    case "finalizing":
      return FieldMode.Completing;
    case "completed":
      return FieldMode.Complete;
    case "failed":
    case "expired":
      return FieldMode.Error;
    default:
      return FieldMode.Idle;
  }
}

export function setFieldPhase(phase: Phase) {
  const next = modeForPhase(phase);
  if (next === field.mode) return;
  const now = typeof performance === "undefined" ? 0 : performance.now();
  if (next === FieldMode.Complete) field.pulseAt = now;
  if (next === FieldMode.Error) field.errorAt = now;
  if (next === FieldMode.Idle || next === FieldMode.Connecting) {
    field.progress = 0;
    field.speed = 0;
  }
  field.mode = next;
}

export function setFieldMetrics(percentage: number, bytesPerSecond: number) {
  field.progress = Math.max(0, Math.min(1, percentage / 100));
  field.speed = Math.max(0, Math.min(1, bytesPerSecond / 30_000_000));
}

/** Target look per mode. Values are eased toward by the render loop. */
export const MODE_TARGETS: Record<
  FieldMode,
  { nodes: number; form: number; flow: number; search: number; converge: number; intensity: number }
> = {
  [FieldMode.Idle]: { nodes: 0.8, form: 1, flow: 0.0, search: 0, converge: 0, intensity: 0.17 },
  [FieldMode.Connecting]: { nodes: 0.75, form: 0.38, flow: 0.28, search: 1, converge: 0, intensity: 0.22 },
  [FieldMode.Connected]: { nodes: 1, form: 1, flow: 0.16, search: 0, converge: 0, intensity: 0.3 },
  [FieldMode.Sending]: { nodes: 1, form: 1, flow: 1, search: 0, converge: 0, intensity: 0.3 },
  [FieldMode.Completing]: { nodes: 1, form: 1, flow: 0.85, search: 0, converge: 1, intensity: 0.3 },
  [FieldMode.Complete]: { nodes: 1, form: 0.45, flow: 0, search: 0, converge: 0.4, intensity: 0.18 },
  [FieldMode.Error]: { nodes: 0.6, form: 0.3, flow: 0.1, search: 0, converge: 0, intensity: 0.25 },
  [FieldMode.Waiting]: { nodes: 0.5, form: 0.16, flow: 0.04, search: 0.5, converge: 0, intensity: 0.15 },
};
