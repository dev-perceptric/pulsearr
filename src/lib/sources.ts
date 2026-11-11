import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appUrl } from "./env.ts";
import { retryResult } from "./retry.ts";
import { HttpError } from "./serverAuth.ts";
import { BACKFILL_OBJECTS, STATE_COOKIE } from "./stripe/index.ts";

// Saving a connected Stripe (connect_source in 010_stripe_sync.sql): the source row with its sealed tokens or key,
// status 'importing', the workspace currency when it has no data yet, and the backfill and first poll jobs.

export type NewSource = {
  workspaceId: string;
  userId: string;
  kind: "stripe_app" | "stripe_key";
  accountId: string;
  accountName: string | null;
  livemode: boolean;
  /** Sealed values only ('v1:...'). */
  accessToken?: string | null;
  refreshToken?: string | null;
  apiKey?: string | null;
  expiresAt?: number | null;
  currency: string | null;
};

/** Save the source and start its import. Returns the source id. */
export async function saveSource(sb: SupabaseClient, s: NewSource): Promise<string> {
  const { data, error } = await retryResult(() =>
    sb.rpc("connect_source", {
      p_ws: s.workspaceId,
      p_user: s.userId,
      p_kind: s.kind,
      p_account: s.accountId,
      p_name: s.accountName,
      p_livemode: s.livemode,
      p_access: s.accessToken ?? null,
      p_refresh: s.refreshToken ?? null,
      p_api_key: s.apiKey ?? null,
      p_expires_at: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
      p_currency: s.currency,
      p_objects: [...BACKFILL_OBJECTS],
    }),
  );
  if (error || typeof data !== "string") {
    console.error("connect_source failed:", error?.message ?? "no id");
    throw new HttpError(500, "We couldn't save the connection. Try again.");
  }
  return data;
}

/** An account's default currency as a lowercase ISO code, or null. */
export const accountCurrency = (a: Record<string, unknown>): string | null =>
  typeof a.default_currency === "string" && /^[a-z]{3}$/i.test(a.default_currency) ? a.default_currency.toLowerCase() : null;

/** Where Stripe sends people back after the install (allowed_redirect_uris in stripe-app/stripe-app.json). */
export const callbackUrl = () => `${appUrl()}/api/stripe/callback`;

/** The cookie holding the connect nonce: only sent to /api/stripe, never readable by page scripts. */
export function stateCookie(value: string, maxAgeS: number): string {
  const secure = appUrl().startsWith("https://") ? "; Secure" : "";
  return `${STATE_COOKIE}=${value}; Path=/api/stripe; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${secure}`;
}

/** The ?error= codes /api/stripe/callback sends to /settings/sources. */
export type CallbackError = "denied" | "state" | "code" | "setup" | "exchange" | "account" | "save";
