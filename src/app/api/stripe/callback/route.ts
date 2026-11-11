// Stripe sends the person here after installing the PulseARR Stripe App: GET ?code=ac_...&state=... (or ?error=...).
// Checks the state (sealed, under 10 minutes old, started in this browser, by someone still an owner or admin),
// trades the code for tokens, reads the account's name and default currency, saves the source with its tokens
// sealed and starts the import, then sends the person to /dashboard. Anything that fails sends them to
// /settings/sources?error=<code>: denied, state, code, setup, exchange, account or save.
import { appUrl, stripeSecretKey } from "../../../../lib/env.ts";
import { retryResult } from "../../../../lib/retry.ts";
import { seal } from "../../../../lib/seal.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "../../../../lib/serverAuth.ts";
import { accountCurrency, saveSource, stateCookie, type CallbackError } from "../../../../lib/sources.ts";
import { accountName, cookieValue, exchangeCode, openState, STATE_COOKIE, stripeClient, type ConnectState, type StripeObject, type StripeTokens } from "../../../../lib/stripe/index.ts";

export const dynamic = "force-dynamic";

const go = (path: string) =>
  new Response(null, { status: 303, headers: { Location: `${appUrl()}${path}`, "Set-Cookie": stateCookie("", 0), "Cache-Control": "no-store" } });
const fail = (code: CallbackError, why?: unknown) => {
  if (why) console.error(`Stripe connect failed (${code}):`, why instanceof Error ? why.message : why);
  return go(`/settings/sources?error=${code}`);
};

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.get("error")) return fail("denied");

  let state: ConnectState;
  try {
    state = openState(params.get("state"), cookieValue(request.headers.get("cookie"), STATE_COOKIE));
  } catch (e) {
    return fail("state", e);
  }
  const code = params.get("code") ?? "";
  if (!/^ac_[A-Za-z0-9_]{1,250}$/.test(code)) return fail("code");
  const secret = stripeSecretKey();
  if (!secret) return fail("setup", "STRIPE_SECRET_KEY is missing");

  let sb: SupabaseClient;
  try {
    const admin = adminClient();
    sb = admin;
    const { data, error } = await retryResult(async () =>
      await admin.from("workspace_members").select("role").eq("workspace_id", state.workspaceId).eq("user_id", state.userId).maybeSingle(),
    );
    if (error) return fail("save", error.message);
    if (!data || !["owner", "admin"].includes(String((data as { role?: unknown }).role))) return fail("state", "no longer an owner or admin");
  } catch (e) {
    return fail("setup", e);
  }

  let tokens: StripeTokens;
  try {
    tokens = await exchangeCode(code, secret);
  } catch (e) {
    return fail("exchange", e);
  }
  let account: StripeObject;
  try {
    account = await stripeClient({ auth: tokens.accessToken }).get("/v1/account");
    if (account.id !== tokens.accountId) throw new Error(`account ${String(account.id)} is not ${tokens.accountId}`);
  } catch (e) {
    return fail("account", e);
  }

  try {
    await saveSource(sb, {
      workspaceId: state.workspaceId,
      userId: state.userId,
      kind: "stripe_app",
      accountId: tokens.accountId,
      accountName: accountName(account),
      livemode: tokens.livemode,
      accessToken: seal(tokens.accessToken),
      refreshToken: seal(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
      currency: accountCurrency(account),
    });
  } catch (e) {
    return fail("save", e);
  }
  return go("/dashboard");
}
