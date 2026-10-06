/** Client-side wrappers for the tiny session API. Only ids, tokens and labels travel here. */

export interface CreatedSession {
  roomId: string;
  hostToken: string;
  joinSecret: string;
  code: string;
  expiresAt: number;
}

export interface JoinedSession {
  roomId: string;
  guestToken: string;
  peer: string;
}

export class SessionApiError extends Error {
  constructor(
    public reason: "not-found" | "occupied" | "forbidden" | "rate-limited" | "network" | "invalid" | "server",
  ) {
    super(reason);
  }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new SessionApiError("network");
  }
  if (res.ok) return (await res.json()) as T;
  const map: Record<number, SessionApiError["reason"]> = {
    400: "invalid",
    403: "forbidden",
    404: "not-found",
    409: "occupied",
    429: "rate-limited",
  };
  throw new SessionApiError(map[res.status] ?? "server");
}

export const createSession = (label: string) => post<CreatedSession>("/api/session", { label });

export const joinSession = (
  by: { roomId: string; secret: string } | { code: string } | { nearby: string },
  label: string,
) => post<JoinedSession>("/api/session/join", { ...by, label });
