import { getRoomStore } from "@/server/rooms";
import { bearer, clientIp, json, originAllowed, rateLimit } from "@/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Signaling downlink safety net: every message for this role numbered after `after`.
 * Streams can stall silently behind proxies (seen with a Cloudflare tunnel), so clients
 * poll alongside the stream and de-duplicate by number.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!originAllowed(req)) return json({ error: "forbidden" }, 403);
  const { id } = await ctx.params;
  const store = getRoomStore();
  const role = store.authenticate(id, bearer(req));
  if (!role) return json({ error: "unauthorized" }, 401);
  if (!rateLimit(`poll:${id}:${role}:${clientIp(req)}`, 300, 60_000)) return json({ error: "rate-limited" }, 429);
  const body = (await req.json().catch(() => ({}))) as { after?: unknown };
  const after = typeof body.after === "number" && Number.isFinite(body.after) ? body.after : 0;
  const events = store.poll(id, role, after);
  return events ? json({ events }) : json({ error: "gone" }, 410);
}
