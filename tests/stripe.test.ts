// The Stripe client, webhook signature, connect state, restricted key check, event parsing and the Stripe API
// routes, with fetch mocked: no real network. The database side (backfill, refresh, sync, poll) is in
// tests/db/stripe_sync.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { json, stubFetch } from "./helpers/serverOnly.ts";

process.env.SUPABASE_URL = "https://db.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = "pk_test";
process.env.SUPABASE_SECRET_KEY = "sk_test";
process.env.SECRETS_KEY = "a-test-secret-key-that-is-long-enough-123";
process.env.APP_URL = "https://app.pulsearr.com";
process.env.STRIPE_SECRET_KEY = "sk_test_platform";
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_secret";

const stripe = await import("../src/lib/stripe/index.ts");
const { unseal } = await import("../src/lib/seal.ts");
const { forgetAuth } = await import("../src/lib/serverAuth.ts");
const { parseEcb } = await import("../src/lib/ecb.ts");
const { JobError } = await import("../src/lib/jobs.ts");
const { stripeFailure } = await import("../worker/stripe/source.ts");
const webhook = await import("../src/app/api/stripe/webhook/route.ts");
const connect = await import("../src/app/api/stripe/connect/route.ts");
const callback = await import("../src/app/api/stripe/callback/route.ts");
const keyRoute = await import("../src/app/api/sources/key/route.ts");
const deleteRoute = await import("../src/app/api/sources/delete/route.ts");

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SRC = "33333333-3333-4333-8333-333333333333";
const FAST = { tries: 3, baseMs: 1, maxMs: 2 };

const fakeFetch = (answer: (u: URL, init: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    calls.push({ url: u, init });
    return answer(u, init);
  }) as typeof fetch;
  return { fetch: f, calls };
};
const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);
const stripeErr = (status: number, message = "x", extra: Record<string, unknown> = {}) => json({ error: { type: "invalid_request_error", message, ...extra } }, status);

// ---------- client ----------

test("encodeParams writes Stripe's form encoding", () => {
  assert.equal(stripe.encodeParams({ limit: 100, expand: ["data.discounts", "data.charge"], created: { gte: 10, lt: 20 }, starting_after: undefined, x: null }), "created[gte]=10&created[lt]=20&expand[]=data.discounts&expand[]=data.charge&limit=100");
  assert.equal(stripe.encodeParams({ email: "a+b@example.com" }), "email=a%2Bb%40example.com");
});

test("every call pins the Stripe-Version and sends the bearer", async () => {
  const s = fakeFetch(() => json({ id: "acct_1", object: "account" }));
  const out = await stripe.stripeClient({ auth: "rk_test_abc", fetch: s.fetch }).get("/v1/account");
  assert.equal(out.id, "acct_1");
  assert.equal(header(s.calls[0]!.init, "stripe-version"), "2024-06-20");
  assert.equal(header(s.calls[0]!.init, "authorization"), "Bearer rk_test_abc");
  assert.equal(stripe.STRIPE_VERSION, "2024-06-20", "the version the fixtures use");
});

test("a 429 waits and tries again, honoring Retry-After; 5xx too; a 400 is thrown at once", async () => {
  let n = 0;
  const s = fakeFetch(() => (++n === 1 ? stripeErr(429, "Too many requests", { type: "rate_limit_error" }) : n === 2 ? json({}, 503, { "Retry-After": "0" }) : json({ object: "list", data: [], has_more: false })));
  const started = Date.now();
  await stripe.stripeClient({ auth: "k", fetch: s.fetch, retry: { tries: 4, baseMs: 20, maxMs: 40 } }).get("/v1/customers");
  assert.equal(s.calls.length, 3);
  assert.ok(Date.now() - started >= 10, "waited between tries");

  const bad = fakeFetch(() => stripeErr(400, "Invalid expand", { param: "expand" }));
  await assert.rejects(stripe.stripeClient({ auth: "k", fetch: bad.fetch, retry: FAST }).get("/v1/customers"), (e: unknown) => e instanceof stripe.StripeError && e.status === 400 && e.param === "expand");
  assert.equal(bad.calls.length, 1, "a mistake is not repeated");

  const busy = fakeFetch(() => stripeErr(429, "Too many requests", { type: "rate_limit_error" }));
  const err = await stripe.stripeClient({ auth: "k", fetch: busy.fetch, retry: FAST }).get("/v1/customers").catch((e) => e);
  assert.ok(stripe.isRateLimited(err));
  assert.equal(busy.calls.length, 3);
  // In a job, a 429 that never cleared waits without using an attempt.
  const noDb = { query: async () => ({ rows: [] }) };
  await assert.rejects(stripeFailure(noDb, { id: SRC, kind: "stripe_key" }, err, "test"), (e: unknown) => e instanceof JobError && e.waitS === 30);
});

test("a 401 refreshes once and tries again with the new token", async () => {
  const s = fakeFetch((_u, init) => (header(init, "authorization") === "Bearer at_new" ? json({ id: "cus_1" }) : stripeErr(401, "Expired")));
  const used: string[] = [];
  const client = stripe.stripeClient({
    fetch: s.fetch,
    retry: FAST,
    auth: {
      token: async () => "at_old",
      refresh: async (u) => {
        used.push(u);
        return "at_new";
      },
    },
  });
  assert.equal((await client.get("/v1/customers/cus_1")).id, "cus_1");
  assert.deepEqual(used, ["at_old"]);
});

test("listAll pages with starting_after", async () => {
  const all = Array.from({ length: 5 }, (_, i) => ({ id: `si_${i}` }));
  const s = fakeFetch((u) => {
    const after = u.searchParams.get("starting_after");
    const start = after ? all.findIndex((x) => x.id === after) + 1 : 0;
    return json({ object: "list", data: all.slice(start, start + 2), has_more: start + 2 < all.length });
  });
  const got = await stripe.stripeClient({ auth: "k", fetch: s.fetch }).listAll("/v1/subscription_items", { subscription: "sub_1", limit: 2 });
  assert.deepEqual(got.map((x) => x.id), all.map((x) => x.id));
  assert.deepEqual(s.calls.map((c) => c.url.searchParams.get("starting_after")), [null, "si_1", "si_3"]);
});

// ---------- webhook signature ----------

const BODY = JSON.stringify({ id: "evt_1", object: "event" });
const NOW = 1_770_000_000_000;

test("a good signature passes; a changed body, another secret, an old timestamp or no header is refused", () => {
  const t = NOW / 1000;
  const h = stripe.signatureHeader(BODY, "whsec_a", t);
  assert.deepEqual(stripe.verifySignature(BODY, h, "whsec_a", { now: NOW }), { t });
  // Several v1 values (during a secret roll): one that matches is enough.
  assert.ok(stripe.verifySignature(BODY, `t=${t},v1=${"0".repeat(64)},${h.split(",")[1]}`, "whsec_a", { now: NOW }));
  const refused = (body: string, header: string | null, secret = "whsec_a", now = NOW) => assert.throws(() => stripe.verifySignature(body, header, secret, { now }), stripe.SignatureError);
  refused(BODY.replace("evt_1", "evt_2"), h);
  refused(BODY, h, "whsec_b");
  refused(BODY, h, "whsec_a", NOW + 301_000);
  refused(BODY, stripe.signatureHeader(BODY, "whsec_a", t - 400));
  refused(BODY, null);
  refused(BODY, `t=${t}`);
  refused(BODY, `t=${t},v1=zz`);
  refused(BODY, h.replace(/v1=(.)/, (_m, c) => `v1=${c === "a" ? "b" : "a"}`));
  refused(BODY, h, "");
});

// ---------- state ----------

test("the connect state opens only unchanged, in time, and in the browser that asked", () => {
  const nonce = stripe.newNonce();
  const state = stripe.sealState({ workspaceId: WS, userId: USER, nonce, now: NOW });
  assert.match(state, /^[A-Za-z0-9_-]+$/, "URL safe");
  assert.deepEqual(stripe.openState(state, nonce, { now: NOW + 60_000 }), { workspaceId: WS, userId: USER, nonce, expiresAt: NOW + 600_000 });
  // Any change to the sealed value: refused.
  for (const i of [0, 10, Math.floor(state.length / 2), state.length - 2]) {
    const flipped = state.slice(0, i) + (state[i] === "A" ? "B" : "A") + state.slice(i + 1);
    assert.throws(() => stripe.openState(flipped, nonce, { now: NOW }), stripe.StateError, `changed at ${i}`);
  }
  // Made with another key (someone forging one): refused.
  assert.throws(() => stripe.openState(stripe.sealState({ workspaceId: WS, userId: USER, nonce, now: NOW }, "another-secret-key-that-is-long-enough-0000"), nonce, { now: NOW }), stripe.StateError);
  assert.throws(() => stripe.openState(state, nonce, { now: NOW + 600_001 }), /ran out/);
  assert.throws(() => stripe.openState(state, stripe.newNonce(), { now: NOW }), /another browser/);
  assert.throws(() => stripe.openState(state, null, { now: NOW }), /another browser/);
  assert.throws(() => stripe.openState("", nonce), stripe.StateError);
  assert.equal(stripe.cookieValue(`a=1; ${stripe.STATE_COOKIE}=${nonce}; b=2`, stripe.STATE_COOKIE), nonce);
});

// ---------- restricted keys ----------

function stripeAccount(probe: (path: string) => Response) {
  return fakeFetch((u, init) => {
    if (u.pathname === "/v1/account" && (init.method ?? "GET") === "GET") return json({ id: "acct_key1", object: "account", default_currency: "EUR", business_profile: { name: "Key Co" } });
    return probe(u.pathname);
  });
}

test("a read-only restricted key is accepted, after probes that can't create anything", async () => {
  const s = stripeAccount(() => stripeErr(403, "The provided key does not have the required permissions for this endpoint"));
  const out = await stripe.checkRestrictedKey("rk_test_readonly123456", { fetch: s.fetch, retry: FAST });
  assert.deepEqual(out, { accountId: "acct_key1", accountName: "Key Co", livemode: false, currency: "eur" });
  const posts = s.calls.filter((c) => c.init.method === "POST");
  assert.deepEqual(posts.map((c) => c.url.pathname).sort(), stripe.WRITE_PROBES.map((p) => p.path).sort());
  assert.ok(posts.every((c) => c.init.body === ""), "every probe leaves out the fields a create needs");
});

test("a restricted key that can write is refused", async () => {
  // Write access to webhook endpoints: Stripe gets past the permission check and only refuses the missing url.
  const s = stripeAccount((path) => (path === "/v1/webhook_endpoints" ? stripeErr(400, "Missing required param: url.", { code: "parameter_missing", param: "url" }) : stripeErr(403, "no permission")));
  await assert.rejects(stripe.checkRestrictedKey("rk_live_canwrite12345", { fetch: s.fetch, retry: FAST }), (e: unknown) => e instanceof stripe.KeyCheckError && e.problem === "can_write");
  const s2 = stripeAccount((path) => (path === "/v1/refunds" ? stripeErr(400, "Missing charge", { code: "parameter_missing" }) : stripeErr(403, "no permission")));
  await assert.rejects(stripe.checkRestrictedKey("rk_live_canwrite12345", { fetch: s2.fetch, retry: FAST }), /can make changes/);
});

test("other keys: wrong kind, refused by Stripe, can't read the account, or a probe we can't read", async () => {
  await assert.rejects(stripe.checkRestrictedKey("sk_live_secret1234567890"), (e: unknown) => e instanceof stripe.KeyCheckError && e.problem === "format");
  const invalid = fakeFetch(() => stripeErr(401, "Invalid API Key"));
  await assert.rejects(stripe.checkRestrictedKey("rk_test_invalid123456", { fetch: invalid.fetch, retry: FAST }), (e: unknown) => e instanceof stripe.KeyCheckError && e.problem === "invalid");
  const noAccount = fakeFetch(() => stripeErr(403, "no permission"));
  await assert.rejects(stripe.checkRestrictedKey("rk_test_noaccount1234", { fetch: noAccount.fetch, retry: FAST }), (e: unknown) => e instanceof stripe.KeyCheckError && e.problem === "account");
  const odd = stripeAccount(() => stripeErr(404, "Unrecognized request URL"));
  await assert.rejects(stripe.checkRestrictedKey("rk_test_oddprobe12345", { fetch: odd.fetch, retry: FAST }), (e: unknown) => e instanceof stripe.KeyCheckError && e.problem === "unchecked");
});

// ---------- events ----------

test("parseEvent keeps the changed keys and picks the object to fetch fresh", () => {
  const e = stripe.parseEvent({
    id: "evt_1",
    object: "event",
    type: "customer.subscription.updated",
    created: 1770000000,
    account: "acct_1",
    livemode: true,
    data: { object: { id: "sub_1", object: "subscription", customer: "cus_1" }, previous_attributes: { status: "trialing", items: {} } },
  })!;
  assert.deepEqual(e, { id: "evt_1", type: "customer.subscription.updated", created: "2026-02-02T02:40:00.000Z", object_id: "sub_1", customer_id: "cus_1", changed: ["items", "status"], sync_type: "subscription", sync_id: "sub_1", account: "acct_1", livemode: true });
  const of = (object: Record<string, unknown>) => {
    const p = stripe.parseEvent({ id: "evt_2", object: "event", type: "x", created: 1, data: { object } })!;
    return [p.sync_type, p.sync_id, p.customer_id];
  };
  assert.deepEqual(of({ id: "cus_9", object: "customer" }), ["customer", "cus_9", "cus_9"]);
  assert.deepEqual(of({ id: "plan_1", object: "plan" }), ["price", "plan_1", null]);
  assert.deepEqual(of({ id: "di_1", object: "discount", subscription: "sub_2", customer: "cus_2" }), ["subscription", "sub_2", "cus_2"]);
  assert.deepEqual(of({ id: "di_2", object: "discount", customer: "cus_3" }), ["customer", "cus_3", "cus_3"]);
  assert.deepEqual(of({ id: "ii_1", object: "invoiceitem", invoice: "in_1", customer: "cus_4" }), ["invoice", "in_1", "cus_4"]);
  assert.deepEqual(of({ id: "cn_1", object: "credit_note", customer: "cus_5" }), [null, null, "cus_5"]);
  assert.equal(stripe.parseEvent({ id: "nope", object: "event", type: "x", created: 1 }), null);
  assert.equal(stripe.parseEvent({ id: "evt_3", object: "charge" }), null);
});

test("rows: a refund keeps its charge as an id and takes the charge's customer; invoice lines from both API shapes", () => {
  const r = stripe.refundRow({ id: "re_1", object: "refund", amount: 500, currency: "USD", created: 1770000000, charge: { id: "ch_1", object: "charge", customer: "cus_1" } });
  assert.equal(r.customer_id, "cus_1");
  assert.equal(r.charge_id, "ch_1");
  assert.equal((r.raw as { charge: unknown }).charge, "ch_1");
  assert.equal(r.currency, "usd");
  const head = { id: "in_1", customerId: "cus_1", subscriptionId: "sub_1" };
  const old = stripe.invoiceLineRow({ id: "il_1", type: "subscription", subscription: "sub_1", subscription_item: "si_1", price: { id: "price_1" }, proration: false, quantity: 2, amount: 6000, discount_amounts: [{ amount: 100 }, { amount: 50 }], period: { start: 1, end: 2 } }, head);
  const now = stripe.invoiceLineRow({ id: "il_2", parent: { type: "subscription_item_details", subscription_item_details: { subscription: "sub_1", subscription_item: "si_1", proration: true } }, pricing: { price_details: { price: "price_1" } }, amount: 10 }, head);
  assert.deepEqual([old.type, old.subscription_item_id, old.price_id, old.discount_amount, old.proration], ["subscription", "si_1", "price_1", 150, false]);
  assert.deepEqual([now.type, now.subscription_item_id, now.price_id, now.proration], ["subscription", "si_1", "price_1", true]);
  assert.deepEqual(stripe.dedupe([{ id: "a", n: 1 }, { id: "b" }, { id: "a", n: 2 }]), [{ id: "a", n: 2 }, { id: "b" }]);
  assert.match(stripe.upsertSql("invoice_lines"), /on conflict \(source_id, invoice_id, id\) do update .* where public\.stripe_invoice_lines\.updated_at <= excluded\.updated_at$/);
});

test("ECB rates parse exactly, euro left out", () => {
  const xml = `<Cube><Cube time='2026-11-10'><Cube currency='USD' rate='1.1214'/><Cube currency='JPY' rate='177.38'/></Cube><Cube time="2026-11-09"><Cube currency="USD" rate="1.12"/></Cube></Cube>`;
  assert.deepEqual(parseEcb(xml), [
    { day: "2026-11-10", quote: "usd", rate: "1.1214" },
    { day: "2026-11-10", quote: "jpy", rate: "177.38" },
    { day: "2026-11-09", quote: "usd", rate: "1.12" },
  ]);
});

// ---------- routes ----------

/** Supabase (auth and rpc) and Stripe behind one fake fetch. */
function backend(o: { admin?: boolean; known?: number; rpcError?: boolean; stripe?: (u: URL, init: RequestInit) => Response; role?: string | null; source?: string | null } = {}) {
  forgetAuth();
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const s = stubFetch(async (url, init) => {
    if (url.hostname === "db.example.test") {
      if (url.pathname === "/auth/v1/user") return json({ id: USER, email: "ann@acme.com", aud: "authenticated" });
      const rpc = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname)?.[1];
      if (rpc === "is_member") return json(true);
      if (rpc === "is_admin") return json(o.admin ?? true);
      if (rpc) {
        rpcs.push({ fn: rpc, args: JSON.parse(String(init.body ?? "{}")) });
        if (o.rpcError) return json({ message: "boom", code: "XX000" }, 400);
        if (rpc === "record_stripe_event") return json(o.known ?? 1);
        if (rpc === "connect_source") return json(SRC);
        if (rpc === "delete_source") return json(WS);
        return json(1);
      }
      if (url.pathname === "/rest/v1/workspace_members") return json(o.role === null ? null : { role: o.role ?? "owner" });
      if (url.pathname === "/rest/v1/sources") return json(o.source === null ? null : { workspace_id: o.source ?? WS });
      if (url.pathname === "/rest/v1/rate_buckets" || url.pathname === "/rest/v1/rpc/take_rate") return json(true);
      return json({ message: "not found" }, 404);
    }
    if (url.hostname === "api.stripe.com" && o.stripe) return o.stripe(url, init);
    return json({ error: { message: "unexpected" } }, 500);
  });
  return { ...s, rpcs };
}

const signed = (event: unknown, secret = "whsec_test_secret") => {
  const body = JSON.stringify(event);
  return new Request("https://app.pulsearr.com/api/stripe/webhook", { method: "POST", body, headers: { "Stripe-Signature": stripe.signatureHeader(body, secret), "Content-Type": "application/json" } });
};
const EVENT = {
  id: "evt_web_1",
  object: "event",
  type: "invoice.paid",
  created: 1770000000,
  account: "acct_conn1",
  livemode: true,
  data: { object: { id: "in_1", object: "invoice", customer: "cus_1" } },
};

test("webhook: a bad signature is refused and nothing is stored", async () => {
  const b = backend();
  try {
    const res = await webhook.POST(signed(EVENT, "whsec_wrong"));
    assert.equal(res.status, 400);
    const unsigned = await webhook.POST(new Request("https://app.pulsearr.com/api/stripe/webhook", { method: "POST", body: JSON.stringify(EVENT) }));
    assert.equal(unsigned.status, 400);
    assert.equal(b.rpcs.length, 0);
  } finally {
    b.restore();
  }
});

test("webhook: a good event is stored for its account with the object to fetch; the same event twice goes to the same once-only insert", async () => {
  const b = backend();
  try {
    for (let i = 0; i < 2; i++) {
      const res = await webhook.POST(signed(EVENT));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { received: true });
    }
    assert.equal(b.rpcs.length, 2);
    assert.deepEqual(b.rpcs[0], {
      fn: "record_stripe_event",
      args: {
        p_account: "acct_conn1",
        p_livemode: true,
        p_event: { id: "evt_web_1", type: "invoice.paid", created: "2026-02-02T02:40:00.000Z", object_id: "in_1", customer_id: "cus_1", changed: null, sync_type: "invoice", sync_id: "in_1" },
      },
    });
    assert.deepEqual(b.rpcs[1], b.rpcs[0], "the database keeps it once (on conflict do nothing; tests/db/stripe_sync.sql)");
  } finally {
    b.restore();
  }
});

test("webhook: an unknown account and a platform event answer 200 and are ignored; a database failure is 500 so Stripe sends it again", async () => {
  const unknown = backend({ known: 0 });
  try {
    const res = await webhook.POST(signed(EVENT));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true, ignored: "unknown account" });
  } finally {
    unknown.restore();
  }
  const platform = backend();
  try {
    const res = await webhook.POST(signed({ ...EVENT, account: undefined }));
    assert.equal(res.status, 200);
    assert.equal(platform.rpcs.length, 0);
  } finally {
    platform.restore();
  }
  const down = backend({ rpcError: true });
  try {
    assert.equal((await webhook.POST(signed(EVENT))).status, 500);
  } finally {
    down.restore();
  }
  const removed = backend();
  try {
    assert.equal((await webhook.POST(signed({ ...EVENT, type: "account.application.deauthorized", data: { object: { id: "ca_1", object: "application" } } }))).status, 200);
    assert.deepEqual(removed.rpcs.map((r) => r.fn), ["source_deauthorized"]);
  } finally {
    removed.restore();
  }
});

const authed = (path: string, body: unknown) =>
  new Request(`https://app.pulsearr.com${path}`, { method: "POST", body: JSON.stringify(body), headers: { Authorization: "Bearer token-ann", "Content-Type": "application/json" } });

test("connect: owners and admins get the install page with a sealed state and a cookie; without a client id, one plain line", async () => {
  delete process.env.STRIPE_APP_CLIENT_ID;
  let b = backend();
  try {
    const res = await connect.POST(authed("/api/stripe/connect", { workspace_id: WS }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "Connecting Stripe isn't set up yet." });
  } finally {
    b.restore();
  }
  process.env.STRIPE_APP_CLIENT_ID = "ca_test_client";
  b = backend({ admin: false });
  try {
    assert.equal((await connect.POST(authed("/api/stripe/connect", { workspace_id: WS }))).status, 403);
  } finally {
    b.restore();
  }
  b = backend();
  try {
    const res = await connect.POST(authed("/api/stripe/connect", { workspace_id: WS }));
    assert.equal(res.status, 200);
    const { url } = (await res.json()) as { url: string };
    const u = new URL(url);
    assert.equal(`${u.origin}${u.pathname}`, "https://marketplace.stripe.com/oauth/v2/authorize");
    assert.equal(u.searchParams.get("client_id"), "ca_test_client");
    assert.equal(u.searchParams.get("redirect_uri"), "https://app.pulsearr.com/api/stripe/callback");
    const cookie = res.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly; SameSite=Lax; Secure/);
    const nonce = /pulsearr_stripe_state=([^;]+)/.exec(cookie)![1]!;
    const st = stripe.openState(u.searchParams.get("state"), nonce);
    assert.equal(st.workspaceId, WS);
    assert.equal(st.userId, USER);
  } finally {
    b.restore();
  }
});

function callbackRequest(o: { state?: string; nonce?: string; code?: string; error?: string } = {}) {
  const nonce = o.nonce ?? "nonce-1";
  const state = o.state ?? stripe.sealState({ workspaceId: WS, userId: USER, nonce });
  const q = new URLSearchParams(o.error ? { error: o.error } : { code: o.code ?? "ac_testcode", state });
  return new Request(`https://app.pulsearr.com/api/stripe/callback?${q}`, { headers: { Cookie: `${stripe.STATE_COOKIE}=${nonce}` } });
}
const tokenAnswer = () => json({ access_token: "at_live_1", refresh_token: "rt_live_1", stripe_user_id: "acct_conn1", livemode: true, scope: "stripe_apps", token_type: "bearer" });
const stripeForCallback = (u: URL, init: RequestInit) => {
  if (u.pathname === "/v1/oauth/token") {
    assert.equal(header(init, "authorization"), `Basic ${Buffer.from("sk_test_platform:").toString("base64")}`);
    assert.equal(new URLSearchParams(String(init.body)).get("code"), "ac_testcode");
    return tokenAnswer();
  }
  if (u.pathname === "/v1/account") {
    assert.equal(header(init, "authorization"), "Bearer at_live_1");
    return json({ id: "acct_conn1", object: "account", default_currency: "gbp", settings: { dashboard: { display_name: "Conn Ltd" } } });
  }
  return json({}, 404);
};

test("callback: a tampered or foreign state never connects anything", async () => {
  const b = backend({ stripe: stripeForCallback });
  try {
    const good = stripe.sealState({ workspaceId: WS, userId: USER, nonce: "nonce-1" });
    const tampered = good.slice(0, 20) + (good[20] === "A" ? "B" : "A") + good.slice(21);
    for (const req of [callbackRequest({ state: tampered }), callbackRequest({ state: good, nonce: "someone-else" }), callbackRequest({ state: "" })]) {
      const res = await callback.GET(req);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("location"), "https://app.pulsearr.com/settings/sources?error=state");
    }
    const denied = await callback.GET(callbackRequest({ error: "access_denied" }));
    assert.equal(denied.headers.get("location"), "https://app.pulsearr.com/settings/sources?error=denied");
    assert.equal(b.rpcs.length, 0);
    assert.ok(!b.calls.some((c) => c.url.hostname === "api.stripe.com"), "no code was traded");
  } finally {
    b.restore();
  }
  const notAdmin = backend({ stripe: stripeForCallback, role: "member" });
  try {
    assert.equal((await callback.GET(callbackRequest())).headers.get("location"), "https://app.pulsearr.com/settings/sources?error=state");
  } finally {
    notAdmin.restore();
  }
});

test("callback: trades the code, saves the source with sealed tokens and the account's currency, and opens the dashboard", async () => {
  const b = backend({ stripe: stripeForCallback });
  try {
    const res = await callback.GET(callbackRequest());
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "https://app.pulsearr.com/dashboard");
    assert.match(res.headers.get("set-cookie")!, /Max-Age=0/, "the state cookie is cleared");
    const save = b.rpcs.find((r) => r.fn === "connect_source")!;
    assert.equal(save.args.p_ws, WS);
    assert.equal(save.args.p_user, USER);
    assert.equal(save.args.p_kind, "stripe_app");
    assert.equal(save.args.p_account, "acct_conn1");
    assert.equal(save.args.p_name, "Conn Ltd");
    assert.equal(save.args.p_currency, "gbp");
    assert.equal(save.args.p_livemode, true);
    assert.deepEqual(save.args.p_objects, [...stripe.BACKFILL_OBJECTS]);
    assert.ok(String(save.args.p_access).startsWith("v1:") && String(save.args.p_refresh).startsWith("v1:"), "sealed");
    assert.equal(unseal(String(save.args.p_access)), "at_live_1");
    assert.equal(unseal(String(save.args.p_refresh)), "rt_live_1");
    assert.ok(!JSON.stringify(b.rpcs).includes("rt_live_1"), "no token in the clear");
  } finally {
    b.restore();
  }
  const failing = backend({ stripe: (u) => (u.pathname === "/v1/oauth/token" ? json({ error: "invalid_grant", error_description: "expired code" }, 400) : json({}, 404)) });
  try {
    assert.equal((await callback.GET(callbackRequest())).headers.get("location"), "https://app.pulsearr.com/settings/sources?error=exchange");
    assert.equal(failing.rpcs.length, 0);
  } finally {
    failing.restore();
  }
});

test("restricted key route: a key that can write is refused; a read-only one is sealed and saved", async () => {
  const account = (u: URL, init: RequestInit) => (u.pathname === "/v1/account" && init.method !== "POST" ? json({ id: "acct_key2", object: "account", default_currency: "usd" }) : null);
  let b = backend({ stripe: (u, init) => account(u, init) ?? stripeErr(400, "Missing required param", { code: "parameter_missing" }) });
  try {
    const res = await keyRoute.POST(authed("/api/sources/key", { workspace_id: WS, key: "rk_live_writeable1234" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "This key can make changes. Use a read-only restricted key." });
    assert.ok(!b.rpcs.some((r) => r.fn === "connect_source"));
  } finally {
    b.restore();
  }
  b = backend({ stripe: (u, init) => account(u, init) ?? stripeErr(403, "no permission") });
  try {
    const bad = await keyRoute.POST(authed("/api/sources/key", { workspace_id: WS, key: "sk_live_notrestricted1" }));
    assert.equal(bad.status, 400);
    const res = await keyRoute.POST(authed("/api/sources/key", { workspace_id: WS, key: " rk_live_readonly12345 " }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, source_id: SRC });
    const save = b.rpcs.find((r) => r.fn === "connect_source")!;
    assert.equal(save.args.p_kind, "stripe_key");
    assert.equal(save.args.p_livemode, true);
    assert.equal(unseal(String(save.args.p_api_key)), "rk_live_readonly12345");
    assert.equal(save.args.p_access, null);
  } finally {
    b.restore();
  }
  b = backend({ admin: false });
  try {
    assert.equal((await keyRoute.POST(authed("/api/sources/key", { workspace_id: WS, key: "rk_live_readonly12345" }))).status, 403);
  } finally {
    b.restore();
  }
});

test("delete route: owners and admins delete; others can't; a gone source is a plain 404", async () => {
  let b = backend();
  try {
    const res = await deleteRoute.POST(authed("/api/sources/delete", { source_id: SRC }));
    assert.equal(res.status, 200);
    assert.deepEqual(b.rpcs, [{ fn: "delete_source", args: { p_source: SRC } }]);
  } finally {
    b.restore();
  }
  b = backend({ admin: false });
  try {
    assert.equal((await deleteRoute.POST(authed("/api/sources/delete", { source_id: SRC }))).status, 403);
    assert.equal(b.rpcs.length, 0);
  } finally {
    b.restore();
  }
  b = backend({ source: null });
  try {
    assert.equal((await deleteRoute.POST(authed("/api/sources/delete", { source_id: SRC }))).status, 404);
    assert.equal((await deleteRoute.POST(authed("/api/sources/delete", { source_id: "nope" }))).status, 400);
  } finally {
    b.restore();
  }
});

test("install link: the public link by default, the external test channel link when set, and a bad link refused", async () => {
  const { installUrl } = await import("../src/lib/stripe/oauth.ts");
  const cb = "https://app.pulsearr.com/api/stripe/callback";
  const pub = new URL(installUrl("ca_abc", cb, "s1"));
  assert.equal(pub.origin + pub.pathname, "https://marketplace.stripe.com/oauth/v2/authorize");
  assert.equal(pub.searchParams.get("client_id"), "ca_abc");
  assert.equal(pub.searchParams.get("redirect_uri"), cb);
  assert.equal(pub.searchParams.get("state"), "s1");
  const testLink = new URL(installUrl("ca_abc", cb, "s1", "chnlink_61VkONh4JDi7PTLZz"));
  assert.equal(testLink.pathname, "/oauth/v2/chnlink_61VkONh4JDi7PTLZz/authorize");
  assert.equal(testLink.searchParams.get("client_id"), "ca_abc");
  assert.equal(new URL(installUrl("ca_abc", cb, "s1", "  ")).pathname, "/oauth/v2/authorize");
  assert.throws(() => installUrl("ca_abc", cb, "s1", "chnlink_x/../../evil"));
});
