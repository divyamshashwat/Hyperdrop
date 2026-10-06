import { createHmac } from "node:crypto";
import { getInfraEnv } from "@/lib/env";
import { json, originAllowed } from "@/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ICE configuration for the browser. In direct-only mode (the default) no TURN
 * server is ever handed out, so a relayed path cannot exist. When relay is
 * enabled, credentials are short-lived HMAC credentials (coturn REST scheme)
 * rather than a static secret baked into the client bundle.
 */
export async function GET(req: Request) {
  if (!originAllowed(req)) return json({ error: "forbidden" }, 403);
  let env;
  try {
    env = getInfraEnv();
  } catch (e) {
    return json({ error: "misconfigured", detail: e instanceof Error ? e.message : "" }, 500);
  }

  const iceServers: RTCIceServer[] = [{ urls: env.NEXT_PUBLIC_STUN_URL }];
  if (env.TRANSFER_POLICY === "allow-relay" && env.NEXT_PUBLIC_TURN_URL) {
    if (env.TURN_SHARED_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + 3600}:origin`;
      const credential = createHmac("sha1", env.TURN_SHARED_SECRET).update(username).digest("base64");
      iceServers.push({ urls: env.NEXT_PUBLIC_TURN_URL, username, credential });
    } else {
      iceServers.push({
        urls: env.NEXT_PUBLIC_TURN_URL,
        username: env.NEXT_PUBLIC_TURN_USERNAME,
        credential: env.NEXT_PUBLIC_TURN_CREDENTIAL,
      });
    }
  }
  return json({ iceServers, policy: env.TRANSFER_POLICY });
}
