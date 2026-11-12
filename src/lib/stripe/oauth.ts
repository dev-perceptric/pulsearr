// Connecting a Stripe account through the PulseARR Stripe App (docs/m1-plan.md section 1, stripe-app/README.md).
//
//   installUrl(clientId, redirectUri, state, channelLink?)   Stripe's install page (the external test link while the
//                                              app awaits review); Stripe sends the person back with ?code&state
//   exchangeCode(code, secretKey)              the install code (single use, 5 minutes) → tokens
//   refreshTokens(refreshToken, secretKey)     → new tokens. The refresh token rolls: the old one stops working, so
//                                              the caller saves the new pair before it uses the access token.
//   sealState / openState                      the sealed `state` value: workspace, person, a nonce that must match
//                                              the cookie set by /api/stripe/connect, and a 10-minute expiry.
//
// Access tokens last an hour; refresh tokens a year (and a new year with each refresh).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { fetchWithRetry, type RetryOptions } from "../retry.ts";
import { seal, unseal } from "../seal.ts";
import { STRIPE_API, StripeError, readBody } from "./client.ts";

export const INSTALL_URL = "https://marketplace.stripe.com/oauth/v2/authorize";
/** How long a state value is good for. */
export const STATE_TTL_MS = 10 * 60_000;
/** How long Stripe access tokens last. */
export const ACCESS_TOKEN_TTL_S = 3600;
/** The cookie that ties a state to the browser that asked for it. */
export const STATE_COOKIE = "pulsearr_stripe_state";

/** Before Stripe publishes the app, installs go through the external test channel link (chnlink_...). */
export const CHANNEL_LINK = /^chnlink_[A-Za-z0-9]+$/;

export function installUrl(clientId: string, redirectUri: string, state: string, channelLink?: string): string {
  const link = channelLink?.trim();
  if (link && !CHANNEL_LINK.test(link)) throw new Error("STRIPE_APP_TEST_LINK must look like chnlink_...");
  const u = new URL(link ? `https://marketplace.stripe.com/oauth/v2/${link}/authorize` : INSTALL_URL);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

export type StripeTokens = {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  livemode: boolean;
  scope: string;
  /** When the access token stops working (ms since epoch). */
  expiresAt: number;
};

type TokenOptions = { fetch?: typeof fetch; retry?: RetryOptions; now?: () => number; base?: string };

async function tokenCall(form: Record<string, string>, secretKey: string, o: TokenOptions): Promise<StripeTokens> {
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not set");
  const res = await fetchWithRetry(
    `${o.base ?? STRIPE_API}/v1/oauth/token`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    },
    { tries: 3, baseMs: 500, maxMs: 4000, ...o.retry, fetch: o.fetch, timeoutMs: 20_000 },
  );
  const body = (await readBody(res)) as Record<string, unknown> | null;
  if (!res.ok) throw new StripeError(res.status, body, res.headers);
  const access = typeof body?.access_token === "string" ? body.access_token : "";
  const refresh = typeof body?.refresh_token === "string" ? body.refresh_token : "";
  const account = typeof body?.stripe_user_id === "string" ? body.stripe_user_id : "";
  if (!access || !refresh || !/^acct_[A-Za-z0-9]+$/.test(account)) throw new StripeError(502, { error: { message: "Stripe's token answer was missing a field" } }, res.headers);
  const expiresIn = typeof body?.expires_in === "number" && body.expires_in > 0 ? body.expires_in : ACCESS_TOKEN_TTL_S;
  return {
    accessToken: access,
    refreshToken: refresh,
    accountId: account,
    livemode: body?.livemode === true,
    scope: typeof body?.scope === "string" ? body.scope : "",
    expiresAt: (o.now ?? Date.now)() + expiresIn * 1000,
  };
}

export const exchangeCode = (code: string, secretKey: string, o: TokenOptions = {}) => tokenCall({ grant_type: "authorization_code", code }, secretKey, o);

export const refreshTokens = (refreshToken: string, secretKey: string, o: TokenOptions = {}) =>
  tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken }, secretKey, o);

/** True when the refresh token no longer works (revoked, rolled, or the app was removed): the person reconnects. */
export const isDeadGrant = (e: unknown) => e instanceof StripeError && (e.type === "invalid_grant" || e.code === "invalid_grant");

// ---------- state ----------

export type ConnectState = { workspaceId: string; userId: string; nonce: string; expiresAt: number };

export const newNonce = () => randomBytes(18).toString("base64url");

/** The state for the install URL: sealed (AES-GCM, so any change makes it unreadable) and URL safe. */
export function sealState(s: { workspaceId: string; userId: string; nonce: string; now?: number; ttlMs?: number }, secret?: string): string {
  const body = JSON.stringify({ w: s.workspaceId, u: s.userId, n: s.nonce, e: (s.now ?? Date.now()) + (s.ttlMs ?? STATE_TTL_MS) });
  return Buffer.from(seal(body, secret)).toString("base64url");
}

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

const B64 = "[A-Za-z0-9+/]*={0,2}";
const SEALED = new RegExp(`^v1:${B64}:${B64}:${B64}$`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Open a state value. Throws StateError when it was changed, has run out, or doesn't match the browser's nonce. */
export function openState(state: string | null | undefined, cookieNonce: string | null | undefined, o: { now?: number; secret?: string } = {}): ConnectState {
  if (!state || state.length > 2000) throw new StateError("No state");
  let parsed: { w?: unknown; u?: unknown; n?: unknown; e?: unknown };
  try {
    // Strict: only the exact text sealState wrote (lenient base64 decoding would let a changed character through).
    const bytes = Buffer.from(state, "base64url");
    const sealed = bytes.toString("utf8");
    if (bytes.toString("base64url") !== state || !SEALED.test(sealed)) throw new StateError("The state was changed");
    parsed = JSON.parse(unseal(sealed, o.secret));
  } catch {
    throw new StateError("The state was changed");
  }
  const { w, u, n, e } = parsed;
  if (typeof w !== "string" || !UUID.test(w) || typeof u !== "string" || !UUID.test(u) || typeof n !== "string" || typeof e !== "number") throw new StateError("The state was changed");
  if ((o.now ?? Date.now()) > e) throw new StateError("The state ran out");
  const a = Buffer.from(n);
  const b = Buffer.from(cookieNonce ?? "");
  if (!cookieNonce || a.length !== b.length || !timingSafeEqual(a, b)) throw new StateError("The state is for another browser");
  return { workspaceId: w, userId: u, nonce: n, expiresAt: e };
}

/** The value of one cookie from a Cookie header. */
export function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
