import { getRoomStore } from "@/server/rooms";
import { bearer, clientIp, json, originAllowed, rateLimit } from "@/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Signaling downlink fallback for clients whose event stream never opens (a proxy or
 * Safari holding the streamed response). Returns, and clears, the queued messages.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!originAllowed(req)) return json({ error: "forbidden" }, 403);
  const { id } = await ctx.params;
  const store = getRoomStore();
  const role = store.authenticate(id, bearer(req));
  if (!role) return json({ error: "unauthorized" }, 401);
  if (!rateLimit(`poll:${id}:${role}:${clientIp(req)}`, 240, 60_000)) return json({ error: "rate-limited" }, 429);
  const events = store.poll(id, role);
  return events ? json({ events }) : json({ error: "gone" }, 410);
}
