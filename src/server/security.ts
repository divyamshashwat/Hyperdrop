import { NextResponse } from "next/server";
import { getInfraEnv } from "@/lib/env";

/** Fixed-window in-memory rate limiter. Good enough for a single Node process. */
interface Bucket {
  count: number;
  resetAt: number;
}
const g = globalThis as unknown as { __originBuckets?: Map<string, Bucket> };
const buckets = (g.__originBuckets ??= new Map());

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
  }
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  return ++b.count <= max;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "local";
}

/** Reject cross-origin browser requests. Same-origin fetches may omit Origin entirely. */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  if (host === req.headers.get("host")) return true;
  const extra = getInfraEnv().ALLOWED_ORIGINS?.split(",").map((s) => s.trim()) ?? [];
  return extra.includes(origin);
}

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function bearer(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

/** Device labels are display-only; keep them boring. */
export function cleanLabel(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  return s.replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 24) || "Device";
}

export const MAX_SIGNAL_BYTES = 16 * 1024;
