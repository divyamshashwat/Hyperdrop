/**
 * The QR / link carries only a room id and a one-time join secret. The secret
 * lives in the URL fragment, which browsers never send to any server.
 */
export function buildJoinLink(origin: string, roomId: string, secret: string): string {
  return `${origin}/r/${roomId}#${secret}`;
}

export function parseJoinHash(hash: string): string | null {
  const s = hash.replace(/^#/, "");
  return /^[A-Za-z0-9_-]{16,64}$/.test(s) ? s : null;
}

export function normalizeCode(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  return digits.length === 6 ? digits : null;
}
