import { z } from "zod";

/**
 * Server-side validation of the WebRTC infrastructure configuration.
 * Never import this from client components: it reads secrets.
 */
const schema = z
  .object({
    NEXT_PUBLIC_STUN_URL: z
      .string()
      .regex(/^stuns?:/, "must start with stun: or stuns:")
      .default("stun:stun.l.google.com:19302"),
    NEXT_PUBLIC_TURN_URL: z.string().regex(/^turns?:/, "must start with turn: or turns:").optional(),
    NEXT_PUBLIC_TURN_USERNAME: z.string().min(1).optional(),
    NEXT_PUBLIC_TURN_CREDENTIAL: z.string().min(1).optional(),
    /** Preferred: coturn `static-auth-secret`. Produces short-lived credentials. */
    TURN_SHARED_SECRET: z.string().min(16).optional(),
    /** direct-only: never use a relay. allow-relay: TURN is an explicit, disclosed fallback. */
    TRANSFER_POLICY: z.enum(["direct-only", "allow-relay"]).default("direct-only"),
    ALLOWED_ORIGINS: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.TRANSFER_POLICY === "allow-relay" && !env.NEXT_PUBLIC_TURN_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["NEXT_PUBLIC_TURN_URL"],
        message: "TRANSFER_POLICY=allow-relay requires NEXT_PUBLIC_TURN_URL",
      });
    }
    if (
      env.NEXT_PUBLIC_TURN_URL &&
      !env.TURN_SHARED_SECRET &&
      !(env.NEXT_PUBLIC_TURN_USERNAME && env.NEXT_PUBLIC_TURN_CREDENTIAL)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["TURN_SHARED_SECRET"],
        message: "TURN needs TURN_SHARED_SECRET (preferred) or a static username + credential",
      });
    }
  });

export type InfraEnv = z.infer<typeof schema>;

let cached: InfraEnv | null = null;

export function getInfraEnv(): InfraEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid WebRTC configuration — ${detail}`);
  }
  cached = parsed.data;
  return cached;
}

export const diagnosticsEnabled = process.env.NEXT_PUBLIC_DIAGNOSTICS === "1";
