import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { secretsKey } from "./env.ts";
import { retryResult } from "./retry.ts";
import { adminClient } from "./serverAuth.ts";

// Rate limits kept in the database (take_rate), so they hold across server processes and restarts. Addresses are
// never stored: only a salted hash.

/**
 * Take one from `bucket`: true when it's allowed, false when `max` were already taken in the last `windowS`
 * seconds. If the database can't answer, the request is let through (and logged), so a hiccup never blocks people.
 */
export async function limit(bucket: string, max: number, windowS: number, db: Pick<SupabaseClient, "rpc"> = adminClient()): Promise<boolean> {
  const { data, error } = await retryResult(() => db.rpc("take_rate", { p_bucket: bucket.slice(0, 200), p_limit: max, p_window_s: windowS }), { tries: 3, baseMs: 200 });
  if (error) {
    console.error("take_rate failed:", error.message);
    return true;
  }
  return data !== false;
}

/** A salted SHA-256 of an IP address (salt from SECRETS_KEY), for rate limits and spam checks. */
export function ipHash(ip: string): string {
  const salt = createHash("sha256").update(`pulsearr-ip:${secretsKey() || "dev"}`).digest("hex");
  return createHash("sha256").update(`${salt}:${ip.trim().toLowerCase()}`).digest("hex");
}

/** The caller's address, as the proxy in front saw it. */
export const clientIp = (h: Headers): string =>
  (h.get("cf-connecting-ip") ?? h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "").trim().slice(0, 100) || "unknown";
