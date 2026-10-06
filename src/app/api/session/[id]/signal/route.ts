import { z } from "zod";
import { getRoomStore } from "@/server/rooms";
import { bearer, clientIp, json, MAX_SIGNAL_BYTES, originAllowed, rateLimit } from "@/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({
  kind: z.enum(["offer", "answer", "ice", "bye"]),
  data: z.unknown(),
});

/** Relay one negotiation message (offer / answer / ICE) to the other peer. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!originAllowed(req)) return json({ error: "forbidden" }, 403);
  const { id } = await ctx.params;
  const store = getRoomStore();
  const role = store.authenticate(id, bearer(req));
  if (!role) return json({ error: "unauthorized" }, 401);
  if (!rateLimit(`signal:${id}:${clientIp(req)}`, 240, 60_000)) return json({ error: "rate-limited" }, 429);

  const raw = await req.text();
  if (raw.length > MAX_SIGNAL_BYTES) return json({ error: "too-large" }, 413);
  let parsed: z.infer<typeof body>;
  try {
    parsed = body.parse(JSON.parse(raw));
  } catch {
    return json({ error: "invalid" }, 400);
  }
  return store.relay(id, role, parsed.kind, parsed.data) ? json({ ok: true }) : json({ error: "gone" }, 410);
}
