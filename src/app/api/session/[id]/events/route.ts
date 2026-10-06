import { getRoomStore, type Conn } from "@/server/rooms";
import { bearer, json, originAllowed } from "@/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-sent events: the signaling downlink. Auth is a bearer header, never a URL. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!originAllowed(req)) return json({ error: "forbidden" }, 403);
  const { id } = await ctx.params;
  const store = getRoomStore();
  const role = store.authenticate(id, bearer(req));
  if (!role) return json({ error: "unauthorized" }, 401);

  const enc = new TextEncoder();
  let conn: Conn | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const closeAll = () => {
        if (ping) clearInterval(ping);
        if (conn) store.detach(id, role, conn);
        try {
          controller.close();
        } catch {}
      };
      conn = {
        send: (event, data) => {
          try {
            controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {}
        },
        close: closeAll,
      };
      // ~2 KB of comment first: some proxies and browsers hold a streamed response until they've seen enough bytes.
      controller.enqueue(enc.encode(`: connected${" ".repeat(2048)}\n\n`));
      if (!store.attach(id, role, conn)) {
        closeAll();
        return;
      }
      ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {}
      }, 15_000);
      req.signal.addEventListener("abort", closeAll);
    },
    cancel() {
      if (ping) clearInterval(ping);
      if (conn) store.detach(id, role, conn);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
