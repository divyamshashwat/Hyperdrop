export type TransferPolicy = "direct-only" | "allow-relay";

export interface IceConfig {
  iceServers: RTCIceServer[];
  policy: TransferPolicy;
}

const FALLBACK: IceConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  policy: "direct-only",
};

/**
 * ICE servers come from the server, never from hardcoded client secrets, so
 * TURN credentials (when relay is enabled) can be short-lived.
 */
export async function loadIceConfig(): Promise<IceConfig> {
  try {
    const res = await fetch("/api/ice", { cache: "no-store" });
    if (!res.ok) return FALLBACK;
    const data = (await res.json()) as IceConfig;
    return data.iceServers?.length ? data : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

export type CandidateType = "host" | "srflx" | "prflx" | "relay" | "unknown";

export interface RouteInfo {
  route: "direct" | "relayed";
  local: CandidateType;
  remote: CandidateType;
  protocol: string;
}

/** Inspect the nominated candidate pair to tell a direct path from a TURN relay. */
export async function inspectRoute(pc: RTCPeerConnection): Promise<RouteInfo | null> {
  const stats = await pc.getStats();
  const byId = new Map<string, Record<string, unknown>>();
  stats.forEach((r) => byId.set(r.id, r));

  let pair: Record<string, unknown> | undefined;
  stats.forEach((r) => {
    if (r.type === "transport" && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId);
  });
  if (!pair) {
    stats.forEach((r) => {
      if (r.type === "candidate-pair" && r.state === "succeeded" && (r.nominated || r.selected)) pair = r;
    });
  }
  if (!pair) return null;

  const type = (id: unknown): CandidateType => {
    const t = byId.get(id as string)?.candidateType as CandidateType | undefined;
    return t ?? "unknown";
  };
  const local = type(pair.localCandidateId);
  const remote = type(pair.remoteCandidateId);
  const protocol = String(byId.get(pair.localCandidateId as string)?.protocol ?? "");
  return { route: local === "relay" || remote === "relay" ? "relayed" : "direct", local, remote, protocol };
}
