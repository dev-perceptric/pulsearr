// The backup connect path: a read-only restricted key (rk_live_ / rk_test_) pasted under Settings → Sources
// (docs/m1-plan.md section 1). checkRestrictedKey reads the account with it, then proves it can't write.
//
// The write probe: POST to endpoints that create things, each with a body missing a required field, so nothing can
// ever be created. Stripe checks a restricted key's permissions before it reads the body:
//   403  the key can't write there (what we want)
//   400  the key got past the permission check and only the body was refused: it can write, so it is refused
//   2xx  can't happen with these bodies; treated as "can write"
//   401  the key doesn't work
// Anything else (a 404, a 5xx that never cleared) means we couldn't tell, and the key is not saved.

import type { RetryOptions } from "../retry.ts";
import { StripeError, stripeClient, type StripeObject } from "./client.ts";

export const RESTRICTED_KEY = /^rk_(live|test)_[A-Za-z0-9]{10,250}$/;

/** POSTs that would create something, each with a required field left out. */
export const WRITE_PROBES: { path: string; params: Record<string, string> }[] = [
  { path: "/v1/webhook_endpoints", params: {} },
  { path: "/v1/products", params: {} },
  { path: "/v1/subscriptions", params: {} },
  { path: "/v1/refunds", params: {} },
];

export type KeyProblem = "format" | "invalid" | "account" | "can_write" | "unchecked";

export class KeyCheckError extends Error {
  problem: KeyProblem;
  constructor(problem: KeyProblem, message: string) {
    super(message);
    this.name = "KeyCheckError";
    this.problem = problem;
  }
}

export type CheckedKey = { accountId: string; accountName: string | null; livemode: boolean; currency: string | null };

export const accountName = (a: StripeObject): string | null => {
  const get = (o: unknown, k: string) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);
  const pick = [get(a.business_profile, "name"), get(get(a.settings, "dashboard"), "display_name"), a.email].find((v) => typeof v === "string" && v.trim());
  return typeof pick === "string" ? pick.trim().slice(0, 200) : null;
};

export async function checkRestrictedKey(key: string, o: { fetch?: typeof fetch; retry?: RetryOptions } = {}): Promise<CheckedKey> {
  if (!RESTRICTED_KEY.test(key)) throw new KeyCheckError("format", "Use a restricted key that starts with rk_live_ or rk_test_.");
  const stripe = stripeClient({ auth: key, fetch: o.fetch, retry: o.retry });
  let account: StripeObject;
  try {
    account = await stripe.get("/v1/account");
  } catch (e) {
    if (e instanceof StripeError && e.status === 401) throw new KeyCheckError("invalid", "Stripe didn't accept this key.");
    if (e instanceof StripeError && e.status === 403) throw new KeyCheckError("account", "This key can't read the account. Give it read access.");
    throw new KeyCheckError("unchecked", "We couldn't check this key. Try again.");
  }
  const accountId = typeof account.id === "string" ? account.id : "";
  if (!/^acct_[A-Za-z0-9]+$/.test(accountId)) throw new KeyCheckError("unchecked", "We couldn't check this key. Try again.");

  const results = await Promise.all(
    WRITE_PROBES.map(async (p) => {
      try {
        await stripe.post(p.path, p.params);
        return "write" as const;
      } catch (e) {
        if (!(e instanceof StripeError)) return "unknown" as const;
        if (e.status === 403) return "read" as const;
        if (e.status === 400) return "write" as const;
        if (e.status === 401) return "invalid" as const;
        return "unknown" as const;
      }
    }),
  );
  if (results.includes("write")) throw new KeyCheckError("can_write", "This key can make changes. Use a read-only restricted key.");
  if (results.includes("invalid")) throw new KeyCheckError("invalid", "Stripe didn't accept this key.");
  if (results.includes("unknown")) throw new KeyCheckError("unchecked", "We couldn't check this key. Try again.");

  const currency = typeof account.default_currency === "string" && /^[a-z]{3}$/i.test(account.default_currency) ? account.default_currency.toLowerCase() : null;
  return { accountId, accountName: accountName(account), livemode: key.startsWith("rk_live_"), currency };
}
