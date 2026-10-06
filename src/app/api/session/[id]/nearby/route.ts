import { getRoomStore } from "@/server/rooms";
import { bearer, clientIp, json, originAllowed, rateLimit } from "@/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The receiver asks for a short-lived, single-use token to broadcast over the
 * Nearby acoustic channel. Only the room's host can ask; a new request revokes
 * the previous token. The token only identifies the room: no SDP, no data.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!originAllowed(req)) return json({ error: "forbidden" }, 403);
  const { id } = await ctx.params;
  const store = getRoomStore();
  if (store.authenticate(id, bearer(req)) !== "host") return json({ error: "unauthorized" }, 401);
  if (!rateLimit(`nearby-issue:${clientIp(req)}`, 20, 60_000)) return json({ error: "rate-limited" }, 429);
  const issued = store.issueNearby(id);
  return issued ? json(issued) : json({ error: "gone" }, 410);
}
