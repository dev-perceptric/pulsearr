import "server-only";
import { connection } from "next/server";
import type { ClientConfig } from "@/components/AuthPage";
import { envVar, supabasePublishableKey, supabaseUrl } from "@/lib/env";

/**
 * What the browser needs to sign in, read when the page is asked for (not at build), so one image runs anywhere and a
 * changed setting applies on restart. Null when a setting is missing: the page shows one plain line and the cause shows
 * on /api/health/setup.
 */
export async function clientConfig(): Promise<ClientConfig | null> {
  await connection();
  const url = supabaseUrl();
  const key = supabasePublishableKey();
  if (!url || !key) return null;
  return { url, key, googleClientId: envVar("GOOGLE_SIGNIN_CLIENT_ID") || envVar("GOOGLE_CLIENT_ID") || null };
}
