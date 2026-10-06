import { z } from "zod";
import { getRoomStore } from "@/server/rooms";
import { bearer, json, originAllowed } from "@/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({ token: z.string().max(128).optional() });

/**
 * Explicit goodbye. `navigator.sendBeacon` cannot set headers, so the token may
 * also arrive in the (tiny) JSON body.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!originAllowed(req)) return json({ error: "forbidden" }, 403);
  const { id } = await ctx.params;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  const store = getRoomStore();
  const role = store.authenticate(id, bearer(req) || (parsed.success ? (parsed.data.token ?? "") : ""));
  if (!role) return json({ error: "unauthorized" }, 401);
  store.leave(id, role);
  return json({ ok: true });
}
