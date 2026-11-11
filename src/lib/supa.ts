import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// One Supabase client for the browser. The page reads SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY on the server at
// request time and passes them in, so one image runs anywhere. Sessions stay in this browser (PKCE) and refresh on
// their own.

let client: { url: string; key: string; sb: SupabaseClient } | null = null;

export function browserClient(url: string, key: string): SupabaseClient {
  if (client && client.url === url && client.key === key) return client.sb;
  const sb = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
  });
  client = { url, key, sb };
  return sb;
}
