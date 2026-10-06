import { z } from "zod";
import { getRoomStore } from "@/server/rooms";
import { clientIp, cleanLabel, json, originAllowed, rateLimit } from "@/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({ label: z.string().max(64).optional() });

/** Create a temporary signaling room (the receiver does this). */
export async function POST(req: Request) {
  if (!originAllowed(req)) return json({ error: "forbidden" }, 403);
  if (!rateLimit(`create:${clientIp(req)}`, 12, 60_000)) return json({ error: "rate-limited" }, 429);
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json({ error: "invalid" }, 400);
  return json(getRoomStore().create(cleanLabel(parsed.data.label)), 201);
}
