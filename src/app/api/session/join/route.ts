import { z } from "zod";
import { getRoomStore } from "@/server/rooms";
import { clientIp, cleanLabel, json, originAllowed, rateLimit } from "@/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.union([
  z.object({
    roomId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    secret: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    label: z.string().max(64).optional(),
  }),
  z.object({ code: z.string().regex(/^\d{6}$/), label: z.string().max(64).optional() }),
  z.object({ nearby: z.string().regex(/^[0-9a-f]{8}$/), label: z.string().max(64).optional() }),
]);

/** Join a room as the sender, via the QR link secret or the 6-digit fallback code. */
export async function POST(req: Request) {
  if (!originAllowed(req)) return json({ error: "forbidden" }, 403);
  const ip = clientIp(req);
  if (!rateLimit(`join:${ip}`, 20, 60_000)) return json({ error: "rate-limited" }, 429);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid" }, 400);

  const by = parsed.data;
  if ("code" in by) {
    // The numeric code is only 20 bits: throttle guessing per client and globally.
    if (!rateLimit(`code:${ip}`, 8, 60_000) || !rateLimit("code:global", 60, 60_000)) {
      return json({ error: "rate-limited" }, 429);
    }
  }
  if ("nearby" in by) {
    // 32 bits, alive for 20 s, single use: guessing is hopeless, but throttle it anyway.
    if (!rateLimit(`nearby:${ip}`, 10, 60_000) || !rateLimit("nearby:global", 120, 60_000)) {
      return json({ error: "rate-limited" }, 429);
    }
  }
  const result = getRoomStore().join(
    "code" in by ? { code: by.code } : "nearby" in by ? { nearby: by.nearby } : { roomId: by.roomId, secret: by.secret },
    cleanLabel(by.label),
  );
  if (!result.ok) {
    const status = result.reason === "occupied" ? 409 : result.reason === "forbidden" ? 403 : 404;
    return json({ error: result.reason }, status);
  }
  return json({ roomId: result.roomId, guestToken: result.guestToken, peer: result.hostLabel });
}
