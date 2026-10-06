import type { SelectedFile } from "../files/file-utils";

/**
 * The single source of truth for what the UI shows. Components derive
 * everything from `Machine`; there are no ad-hoc booleans scattered about.
 */
export type Phase =
  | "idle"
  | "selecting-files"
  | "files-selected"
  | "creating-session"
  | "waiting-for-peer"
  | "pairing"
  | "connecting"
  | "connected"
  | "awaiting-acceptance"
  | "sending"
  | "receiving"
  | "finalizing"
  | "completed"
  | "paused"
  | "reconnecting"
  | "failed"
  | "expired"
  | "cancelled";

export type Role = "sender" | "receiver" | null;
export type Route = "direct" | "relayed" | null;

export type ErrorCode =
  | "connection-failed"
  | "interrupted"
  | "peer-left"
  | "session-expired"
  | "unsupported"
  | "permission"
  | "verification-failed"
  | "rejected"
  | "peer-cancelled"
  | "session-not-found"
  | "session-busy"
  | "rate-limited"
  | "storage"
  | "protocol"
  | "relay-blocked"
  | "unknown";

export interface PairingInfo {
  roomId: string;
  code: string;
  link: string;
  expiresAt: number;
}

export interface Summary {
  fileCount: number;
  totalBytes: number;
  names: string[];
}

export interface Machine {
  phase: Phase;
  role: Role;
  files: SelectedFile[];
  pairing: PairingInfo | null;
  peerLabel: string | null;
  route: Route;
  summary: Summary | null;
  error: { code: ErrorCode; detail?: string } | null;
  /** Phase to return to when a reconnect succeeds. */
  resumePhase: "sending" | "receiving" | "awaiting-acceptance" | "connected" | null;
  /** Percent resumed from, shown once after a successful resume. */
  resumedFrom: number | null;
  /** Set when a sender has clicked through a QR link, so Reset can return to it. */
  linked: boolean;
}

export const INITIAL: Machine = {
  phase: "idle",
  role: null,
  files: [],
  pairing: null,
  peerLabel: null,
  route: null,
  summary: null,
  error: null,
  resumePhase: null,
  resumedFrom: null,
  linked: false,
};

export type Action =
  | { type: "PICK_OPEN" }
  | { type: "PICK_CANCEL" }
  | { type: "FILES_ADD"; files: SelectedFile[] }
  | { type: "FILES_REMOVE"; id: string }
  | { type: "FILES_CLEAR" }
  | { type: "RECEIVE_START" }
  | { type: "SESSION_READY"; pairing: PairingInfo }
  | { type: "PAIRING"; linked?: boolean }
  | { type: "PEER_JOINED"; label: string }
  | { type: "CONNECTING"; label?: string }
  | { type: "CONNECTED"; label?: string; route: Route }
  | { type: "ROUTE"; route: Route }
  | { type: "OFFER_SENT"; summary: Summary }
  | { type: "OFFER_RECEIVED"; summary: Summary }
  | { type: "TRANSFER_STARTED"; resumedFrom?: number }
  | { type: "FINALIZING" }
  | { type: "COMPLETED"; summary?: Summary }
  | { type: "RECONNECTING" }
  | { type: "PAUSED" }
  | { type: "RESUMED" }
  | { type: "FAILED"; code: ErrorCode; detail?: string }
  | { type: "EXPIRED" }
  | { type: "CANCELLED"; byPeer?: boolean }
  | { type: "BACK_TO_FILES" }
  /** Sender, session still alive: straight back to choosing photos. */
  | { type: "SEND_MORE" }
  | { type: "RESET" };

const ACTIVE: Phase[] = ["sending", "receiving", "finalizing", "awaiting-acceptance"];
const LIVE: Phase[] = ["connecting", "connected", ...ACTIVE];

/** Which phases an action may be applied from. Anything else is ignored. */
const ALLOWED: Partial<Record<Action["type"], Phase[]>> = {
  PICK_OPEN: ["idle", "files-selected", "connecting", "connected"],
  PICK_CANCEL: ["selecting-files"],
  RECEIVE_START: ["idle", "files-selected", "failed", "expired", "cancelled"],
  SESSION_READY: ["creating-session"],
  PAIRING: ["idle", "files-selected", "failed", "expired", "cancelled"],
  PEER_JOINED: ["waiting-for-peer"],
  CONNECTING: ["waiting-for-peer", "pairing", "connecting"],
  CONNECTED: ["connecting", "reconnecting", "paused", "pairing", "waiting-for-peer"],
  OFFER_SENT: ["connected"],
  OFFER_RECEIVED: ["connected", "connecting", "waiting-for-peer", "completed"],
  SEND_MORE: ["completed"],
  TRANSFER_STARTED: ["awaiting-acceptance", "connected", "reconnecting", "paused", "sending", "receiving"],
  FINALIZING: ["sending", "receiving"],
  COMPLETED: ["sending", "receiving", "finalizing", "awaiting-acceptance"],
  RECONNECTING: ["connecting", "connected", ...ACTIVE],
  PAUSED: ["reconnecting"],
  RESUMED: ["reconnecting", "paused"],
  BACK_TO_FILES: ["failed", "cancelled", "expired", "completed"],
};

export function reduce(m: Machine, a: Action): Machine {
  const allowed = ALLOWED[a.type];
  if (allowed && !allowed.includes(m.phase)) return m;

  switch (a.type) {
    case "PICK_OPEN":
      return m.phase === "idle" ? { ...m, phase: "selecting-files", role: "sender" } : m;
    case "PICK_CANCEL":
      return { ...m, phase: m.files.length ? "files-selected" : "idle", role: m.files.length ? "sender" : null };
    case "FILES_ADD": {
      if (!a.files.length) return m.phase === "selecting-files" ? reduce(m, { type: "PICK_CANCEL" }) : m;
      if (!["idle", "selecting-files", "files-selected", "pairing", "connecting", "connected"].includes(m.phase)) return m;
      const files = [...m.files, ...a.files];
      const phase = ["pairing", "connecting", "connected"].includes(m.phase) ? m.phase : "files-selected";
      return { ...m, files, phase, role: "sender", error: null };
    }
    case "FILES_REMOVE": {
      const files = m.files.filter((f) => f.id !== a.id);
      if (m.phase === "files-selected" && files.length === 0) return { ...m, files, phase: "idle", role: null };
      return { ...m, files };
    }
    case "FILES_CLEAR":
      return m.phase === "files-selected" ? { ...m, files: [], phase: "idle", role: null } : { ...m, files: [] };
    case "RECEIVE_START":
      return { ...INITIAL, phase: "creating-session", role: "receiver" };
    case "SESSION_READY":
      return { ...m, phase: "waiting-for-peer", pairing: a.pairing };
    case "PAIRING":
      return { ...m, phase: "pairing", role: "sender", error: null, linked: a.linked ?? m.linked };
    case "PEER_JOINED":
      return { ...m, phase: "connecting", peerLabel: a.label };
    case "CONNECTING":
      return { ...m, phase: "connecting", peerLabel: a.label ?? m.peerLabel };
    case "ROUTE":
      return m.phase === "idle" ? m : { ...m, route: a.route };
    case "CONNECTED": {
      const wasLive = m.resumePhase;
      const base = { ...m, peerLabel: a.label ?? m.peerLabel, route: a.route, error: null };
      if (m.phase === "reconnecting" || m.phase === "paused") {
        return { ...base, phase: wasLive ?? "connected", resumePhase: null };
      }
      return { ...base, phase: "connected" };
    }
    case "OFFER_SENT":
      return { ...m, phase: "awaiting-acceptance", summary: a.summary };
    case "OFFER_RECEIVED":
      return { ...m, phase: "awaiting-acceptance", summary: a.summary };
    case "TRANSFER_STARTED":
      return {
        ...m,
        phase: m.role === "receiver" ? "receiving" : "sending",
        resumedFrom: a.resumedFrom ?? null,
        resumePhase: null,
      };
    case "FINALIZING":
      return { ...m, phase: "finalizing" };
    case "COMPLETED":
      return { ...m, phase: "completed", summary: a.summary ?? m.summary, resumePhase: null };
    case "RECONNECTING": {
      if (m.phase === "reconnecting") return m;
      const resumePhase = ACTIVE.includes(m.phase) ? (m.phase === "finalizing" ? "sending" : m.phase) : "connected";
      return { ...m, phase: "reconnecting", resumePhase: resumePhase as Machine["resumePhase"] };
    }
    case "PAUSED":
      return { ...m, phase: "paused", error: { code: "interrupted" } };
    case "RESUMED":
      return { ...m, phase: "reconnecting", error: null };
    case "FAILED":
      return { ...m, phase: "failed", error: { code: a.code, detail: a.detail } };
    case "EXPIRED":
      if (m.phase === "completed" || m.phase === "idle") return m;
      return { ...m, phase: "expired", error: { code: "session-expired" } };
    case "CANCELLED":
      return {
        ...m,
        phase: "cancelled",
        error: a.byPeer ? { code: "peer-cancelled" } : null,
      };
    case "BACK_TO_FILES":
      return m.role === "sender" && m.files.length
        ? { ...m, phase: "files-selected", error: null, summary: null, route: null, pairing: null }
        : INITIAL;
    case "SEND_MORE":
      return { ...m, phase: "connected", files: [], summary: null, resumedFrom: null, error: null };
    case "RESET":
      return INITIAL;
  }
}

export const isTransferring = (p: Phase) => p === "sending" || p === "receiving" || p === "finalizing";
export const isLive = (p: Phase) => LIVE.includes(p);

