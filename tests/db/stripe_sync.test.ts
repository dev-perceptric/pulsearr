// The Stripe jobs against a real database (scripts/test-db.sh gives each tests/db/*.test.ts its own copy, in
// TEST_DATABASE_URL), with Stripe and the ECB mocked: no real network. Covers the reliability cases in
// docs/m1-plan.md section 6: a lost lease in the middle of a backfill picks up at the checkpoint without duplicate
// rows, a 429 waits and retries, token refresh rolls and saves the refresh token (once, with two workers at it),
// events twice and out of order end in the same rows, and the whole import over every fixture gives the fixture's
// hand-worked movements.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";

process.env.SECRETS_KEY = "a-test-secret-key-that-is-long-enough-123";
const { seal, unseal } = await import("../../src/lib/seal.ts");
const { JobError, runJob } = await import("../../src/lib/jobs.ts");
const { makeHandlers } = await import("../../worker/handlers.ts");
const { pgRpc } = await import("../../worker/pg.ts");
const { sourceClient, upsertRows } = await import("../../worker/stripe/source.ts");
const { BACKFILL_OBJECTS, eventRow, parseEvent, subscriptionRow } = await import("../../src/lib/stripe/index.ts");
type Job = import("../../src/lib/jobs.ts").Job;
type Handler = import("../../src/lib/jobs.ts").Handler;
type Obj = Record<string, unknown>;

const url = process.env.TEST_DATABASE_URL;
const pool = new pg.Pool({ connectionString: url, max: 6 });
const FAST = { tries: 3, baseMs: 1, maxMs: 2 };
const signal = new AbortController().signal;

const q = async <R = Obj>(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows as R[];
const one = async <R = Obj>(text: string, params: unknown[] = []) => (await q<R>(text, params))[0]!;

let wsN = 0;
async function workspace(currency = "usd"): Promise<string> {
  const id = `f0000000-0000-4000-8000-${String(++wsN).padStart(12, "0")}`;
  await q("insert into public.workspaces (id, name, currency) values ($1, $2, $3)", [id, `ws ${wsN}`, currency]);
  return id;
}

async function keySource(ws: string, key: string, objects: string[] = [], account = `acct_${key.replace(/[^A-Za-z0-9]/g, "")}`): Promise<string> {
  const { id } = await one<{ id: string }>(
    "select public.connect_source($1, null, 'stripe_key', $2, null, false, null, null, $3, null, null, $4::text[]) as id",
    [ws, account, seal(key), objects],
  );
  return id;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
const list = (data: unknown[], has_more = false) => json({ object: "list", data, has_more });

/** A page of `all` the way Stripe pages: `limit` after `starting_after`. */
function page(all: Obj[], u: URL) {
  const limit = Number(u.searchParams.get("limit") ?? 10);
  const after = u.searchParams.get("starting_after");
  const start = after ? all.findIndex((o) => o.id === after) + 1 : 0;
  const data = all.slice(start, start + limit);
  return list(data, start + limit < all.length);
}

type Call = { url: URL; method: string; auth: string; body: string };
function fakeFetch(answer: (u: URL, c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const h = new Headers(init.headers);
    const c = { url: u, method: init.method ?? "GET", auth: h.get("authorization") ?? "", body: typeof init.body === "string" ? init.body : "" };
    calls.push(c);
    if (u.hostname === "api.stripe.com" && u.pathname !== "/v1/oauth/token") assert.equal(h.get("stripe-version"), "2024-06-20", "every Stripe call pins the API version");
    return answer(u, c);
  }) as typeof fetch;
  return { fetch: f, calls };
}

/** Claim and run every ready job of these kinds, until none is left. Tests that drain start with an empty queue. */
async function drain(handlersFor: (job: Job) => Record<string, Handler>, kinds: string[], max = 500): Promise<Record<string, number>> {
  const ran: Record<string, number> = {};
  for (let i = 0; i < max; i++) {
    const jobs = await q<Job>("select * from public.claim_job($1::text[], 'test-worker', 30, 10)", [kinds]);
    if (!jobs.length) return ran;
    for (const job of jobs) {
      const result = await runJob(pgRpc(pool), "test-worker", job, handlersFor(job)[job.kind], 30);
      ran[`${job.kind}:${result}`] = (ran[`${job.kind}:${result}`] ?? 0) + 1;
    }
  }
  throw new Error("drain: too many rounds");
}

before(async () => {
  assert.ok(url, "TEST_DATABASE_URL is set by scripts/test-db.sh");
});
after(async () => {
  await pool.end();
});

// ---------- backfill: lost lease, 429 ----------

test("a lost lease in the middle of a backfill picks up at the checkpoint, with no duplicate rows", async () => {
  await q("delete from public.jobs");
  const ws = await workspace();
  const src = await keySource(ws, "rk_test_lease0000001", ["customers"]);
  const customers = Array.from({ length: 250 }, (_, i) => ({ id: `cus_${String(250 - i).padStart(4, "0")}`, object: "customer", email: `c${i}@example.com`, created: 1767225600 + i }));
  const lease = new AbortController();
  const s = fakeFetch((u) => {
    if (u.pathname === "/v1/test_helpers/test_clocks") return list([]);
    assert.equal(u.pathname, "/v1/customers");
    // The lease is lost while the second page is being written.
    if (u.searchParams.get("starting_after") === customers[99]!.id) lease.abort(new JobError("The job's lease was lost"));
    return page(customers, u);
  });
  const handlers = makeHandlers({ db: pool, fetch: s.fetch, retry: FAST, log: () => {} });

  const [job] = await q<Job>("select * from public.claim_job(array['stripe.backfill'], 'w1', 30, 1)");
  assert.equal(job!.kind, "stripe.backfill");
  await assert.rejects(handlers["stripe.backfill"]!(job!, lease.signal), /lease was lost/);
  const mid = await one<{ n: string; state: Obj }>("select (select count(*) from public.stripe_customers where source_id = $1)::text as n, backfill->'customers' as state from public.sources where id = $1", [src]);
  assert.equal(mid.n, "200", "the second page was written before the lease was lost");
  assert.equal(mid.state.cursor, customers[99]!.id, "the checkpoint is the last page that finished");
  assert.equal(mid.state.done, false);

  // The worker never answers again: the lease runs out and another worker takes the job.
  await q("update public.jobs set locked_until = now() - interval '1 second' where id = $1", [job!.id]);
  const [again] = await q<Job>("select * from public.claim_job(array['stripe.backfill'], 'w2', 30, 1)");
  assert.equal(again!.id, job!.id, "the same job comes back");
  const before2 = s.calls.length;
  assert.equal(await runJob(pgRpc(pool), "w2", again!, handlers["stripe.backfill"], 30), "done");
  assert.equal(s.calls[before2]!.url.searchParams.get("starting_after"), customers[99]!.id, "it resumed after the checkpoint");
  const end = await one<{ n: string; distinct: string; state: Obj }>(
    "select (select count(*) from public.stripe_customers where source_id = $1)::text as n, (select count(distinct id) from public.stripe_customers where source_id = $1)::text as distinct, backfill->'customers' as state from public.sources where id = $1",
    [src],
  );
  assert.equal(end.n, "250");
  assert.equal(end.distinct, "250");
  assert.equal(end.state.done, true);
  assert.equal(end.state.count, 250);
});

test("a test-mode backfill also reads every test clock, each with its own cursor; a live one never asks", async () => {
  await q("delete from public.jobs");
  const ws = await workspace();
  const src = await keySource(ws, "rk_test_clocks000001", ["customers"]);
  const onClock: Record<string, Obj[]> = {
    clock_a: Array.from({ length: 150 }, (_, i) => ({ id: `cus_a${String(i).padStart(4, "0")}`, object: "customer", created: 1767225600 + i })),
    clock_b: [{ id: "cus_b0001", object: "customer", created: 1767225600 }],
  };
  const plain = [{ id: "cus_plain1", object: "customer", created: 1767225600 }];
  const s = fakeFetch((u) => {
    if (u.pathname === "/v1/test_helpers/test_clocks") return list([{ id: "clock_b", object: "test_helpers.test_clock" }, { id: "clock_gone", object: "test_helpers.test_clock" }, { id: "clock_a", object: "test_helpers.test_clock" }]);
    assert.equal(u.pathname, "/v1/customers");
    const clock = u.searchParams.get("test_clock");
    if (clock === "clock_gone") return json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such test clock" } }, 404);
    return page(clock ? onClock[clock]! : plain, u);
  });
  const handlers = makeHandlers({ db: pool, fetch: s.fetch, retry: FAST, log: () => {} });
  const ran = await drain(() => handlers, ["stripe.backfill"]);
  assert.equal(ran["stripe.backfill:done"], 1);
  const end = await one<{ n: string; state: Obj }>("select (select count(*) from public.stripe_customers where source_id = $1)::text as n, backfill->'customers' as state from public.sources where id = $1", [src]);
  assert.equal(end.n, "152", "the plain list plus both clocks");
  assert.equal(end.state.done, true);
  assert.deepEqual(end.state.clocks, ["clock_a", "clock_b", "clock_gone"]);
  assert.equal(s.calls.filter((c) => c.url.pathname === "/v1/test_helpers/test_clocks").length, 1, "clocks are listed once");
  const second = s.calls.find((c) => c.url.searchParams.get("test_clock") === "clock_a" && c.url.searchParams.get("starting_after"));
  assert.equal(second?.url.searchParams.get("starting_after"), "cus_a0099", "a clock pages with its own cursor");
  assert.equal(s.calls.find((c) => c.url.searchParams.get("test_clock") === "clock_b")?.url.searchParams.get("starting_after"), null, "the next clock starts from the top");

  // A key that can't read test clocks still finishes with the plain list.
  await q("delete from public.jobs");
  const ws2 = await workspace();
  const src2 = await keySource(ws2, "rk_test_clocks000002", ["customers"]);
  const s2 = fakeFetch((u) => (u.pathname === "/v1/test_helpers/test_clocks" ? json({ error: { type: "invalid_request_error", message: "The provided key does not have the required permissions" } }, 403) : page(plain, u)));
  await drain(() => makeHandlers({ db: pool, fetch: s2.fetch, retry: FAST, log: () => {} }), ["stripe.backfill"]);
  const end2 = await one<{ n: string; state: Obj }>("select (select count(*) from public.stripe_customers where source_id = $1)::text as n, backfill->'customers' as state from public.sources where id = $1", [src2]);
  assert.equal(end2.n, "1");
  assert.equal(end2.state.done, true);

  // A live source never lists test clocks.
  await q("delete from public.jobs");
  const ws3 = await workspace();
  const { id: src3 } = await one<{ id: string }>(
    "select public.connect_source($1, null, 'stripe_key', 'acct_liveclocks', null, true, null, null, $2, null, null, array['customers']::text[]) as id",
    [ws3, seal("rk_live_clocks000003")],
  );
  const s3 = fakeFetch((u) => page(plain, u));
  await drain(() => makeHandlers({ db: pool, fetch: s3.fetch, retry: FAST, log: () => {} }), ["stripe.backfill"]);
  assert.ok(s3.calls.every((c) => c.url.pathname === "/v1/customers"), "only the plain list");
  assert.equal((await one<{ state: Obj }>("select backfill->'customers' as state from public.sources where id = $1", [src3])).state.done, true);
});

test("a 429 from Stripe waits and retries; one that never clears puts the job back without using an attempt", async () => {
  const ws = await workspace();
  const src = await keySource(ws, "rk_test_ratelimit0001", []);
  let n = 0;
  const s = fakeFetch((u) => (++n === 1 ? json({ error: { type: "rate_limit_error", message: "Too many requests" } }, 429) : page([{ id: "prod_1", object: "product", name: "Pro" }], u)));
  const h = makeHandlers({ db: pool, fetch: s.fetch, retry: FAST, log: () => {} });
  await h["stripe.backfill"]!({ id: "x", workspace_id: ws, kind: "stripe.backfill", key: "", payload: { source_id: src, object: "products" }, attempts: 1, max_attempts: 5 }, signal);
  assert.equal(s.calls.length, 2, "tried again after the 429");
  assert.equal((await one<{ n: string }>("select count(*)::text as n from public.stripe_products where source_id = $1", [src])).n, "1");

  const busy = fakeFetch(() => json({ error: { type: "rate_limit_error", message: "Too many requests" } }, 429));
  const h2 = makeHandlers({ db: pool, fetch: busy.fetch, retry: FAST, log: () => {} });
  await assert.rejects(
    h2["stripe.backfill"]!({ id: "x", workspace_id: ws, kind: "stripe.backfill", key: "", payload: { source_id: src, object: "prices" }, attempts: 1, max_attempts: 5 }, signal),
    (e: unknown) => e instanceof JobError && e.waitS === 30,
  );
  assert.equal(busy.calls.length, FAST.tries);
});

// ---------- token refresh ----------

async function appSource(ws: string, account: string, access: string, refresh: string, expiresInS: number): Promise<string> {
  const { id } = await one<{ id: string }>(
    "select public.connect_source($1, null, 'stripe_app', $2, null, true, $3, $4, null, now() + make_interval(secs => $5), null, '{}') as id",
    [ws, account, seal(access), seal(refresh), expiresInS],
  );
  await q("update public.sources set status = 'live' where id = $1", [id]);
  return id;
}

test("token refresh rolls the refresh token, saves it before use, and runs once with two workers at it", async () => {
  const ws = await workspace();
  const src = await appSource(ws, "acct_refresh1", "at_old", "rt_old", -60);
  let valid = new Set<string>();
  let rolls = 0;
  const s = fakeFetch(async (u, c) => {
    if (u.pathname === "/v1/oauth/token") {
      const form = new URLSearchParams(c.body);
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(c.auth, `Basic ${Buffer.from("sk_test_platform:").toString("base64")}`, "refreshes with the platform key");
      const map: Record<string, [string, string]> = { rt_old: ["at_new", "rt_new"], rt_new: ["at_3", "rt_3"] };
      const next = map[form.get("refresh_token") ?? ""];
      if (!next) return json({ error: "invalid_grant", error_description: "Refresh token is invalid" }, 400);
      delete map[form.get("refresh_token")!];
      rolls++;
      await new Promise((r) => setTimeout(r, 30));
      valid = new Set([next[0]]);
      return json({ access_token: next[0], refresh_token: next[1], stripe_user_id: "acct_refresh1", livemode: true, scope: "stripe_apps", token_type: "bearer" });
    }
    if (!valid.has(c.auth.replace("Bearer ", ""))) return json({ error: { type: "invalid_request_error", message: "Expired API Key provided" } }, 401);
    return json({ id: "acct_refresh1", object: "account" });
  });
  const deps = { db: pool, fetch: s.fetch, retry: FAST, secretKey: () => "sk_test_platform", log: () => {} };
  const source = { id: src, kind: "stripe_app" as const };
  // Two workers find the token expired at once.
  const [a, b] = await Promise.all([sourceClient(deps, source).get("/v1/account"), sourceClient(deps, source).get("/v1/account")]);
  assert.equal(a.id, "acct_refresh1");
  assert.equal(b.id, "acct_refresh1");
  assert.equal(rolls, 1, "refreshed once: the second worker used the token the first saved");
  const row = await one<{ access_token: string; refresh_token: string; fresh: boolean }>(
    "select access_token, refresh_token, token_expires_at > now() + interval '50 minutes' as fresh from public.sources where id = $1",
    [src],
  );
  assert.equal(unseal(row.refresh_token), "rt_new", "the rolled refresh token is saved");
  assert.equal(unseal(row.access_token), "at_new");
  assert.ok(row.access_token.startsWith("v1:") && row.refresh_token.startsWith("v1:"), "sealed");
  assert.ok(row.fresh);

  // Stripe refuses a token early (401): refreshed once more with the saved refresh token.
  valid = new Set();
  const c = await sourceClient(deps, source).get("/v1/account");
  assert.equal(c.id, "acct_refresh1");
  assert.equal(rolls, 2);
  assert.equal(unseal((await one<{ refresh_token: string }>("select refresh_token from public.sources where id = $1", [src])).refresh_token), "rt_3");
  const last = s.calls.filter((x) => x.url.pathname === "/v1/oauth/token").at(-1)!;
  assert.equal(new URLSearchParams(last.body).get("refresh_token"), "rt_new", "used the refresh token saved last time");
});

test("a refresh token Stripe no longer accepts marks the source and stops the job", async () => {
  const ws = await workspace();
  const src = await appSource(ws, "acct_dead1", "at_x", "rt_dead", -60);
  const s = fakeFetch((u) => (u.pathname === "/v1/oauth/token" ? json({ error: "invalid_grant", error_description: "Refresh token is invalid" }, 400) : json({}, 500)));
  const h = makeHandlers({ db: pool, fetch: s.fetch, retry: FAST, stripeSecretKey: () => "sk_test_platform", log: () => {} });
  await assert.rejects(
    h["stripe.sync_object"]!({ id: "x", workspace_id: ws, kind: "stripe.sync_object", key: "", payload: { source_id: src, object_type: "customer", object_id: "cus_1" }, attempts: 1, max_attempts: 5 }, signal),
    (e: unknown) => e instanceof JobError && !e.retry,
  );
  const row = await one<{ status: string; last_error: string }>("select status, last_error from public.sources where id = $1", [src]);
  assert.equal(row.status, "error");
  assert.match(row.last_error, /Connect Stripe again/);
});

// ---------- events: twice, out of order ----------

const sub = (quantity: number, status = "active") => ({
  id: "sub_ooo",
  object: "subscription",
  customer: "cus_ooo",
  status,
  currency: "usd",
  created: 1767225600,
  start_date: 1767225600,
  current_period_start: 1772323200,
  current_period_end: 1775001600,
  cancel_at_period_end: false,
  items: {
    object: "list",
    has_more: false,
    data: [
      {
        id: "si_ooo",
        object: "subscription_item",
        quantity,
        created: 1767225600,
        subscription: "sub_ooo",
        price: { id: "price_ooo", object: "price", currency: "usd", type: "recurring", unit_amount: 1000, billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } },
      },
    ],
  },
});
const evt = (id: string, created: number, quantity: number) => ({
  id,
  object: "event",
  type: "customer.subscription.updated",
  created,
  livemode: false,
  data: { object: sub(quantity), previous_attributes: { items: {}, quantity: quantity - 1 } },
});

test("the same event twice is stored once, and events out of order end in the same rows", async () => {
  // Stripe's current state: 3 seats. Events: 2 seats (older), then 3 seats (newer).
  const s = fakeFetch((u) => {
    if (u.pathname === "/v1/subscriptions/sub_ooo") return json(sub(3));
    return json({ error: { type: "invalid_request_error", message: `No such object: ${u.pathname}` } }, 404);
  });
  const h = makeHandlers({ db: pool, fetch: s.fetch, retry: FAST, log: () => {}, today: () => "2026-03-15" });
  const older = evt("evt_ooo_1", 1770000000, 2);
  const newer = evt("evt_ooo_2", 1771000000, 3);
  const record = (src: string, e: Obj) => one<{ n: number }>("select public.record_stripe_events($1, $2::jsonb) as n", [src, JSON.stringify([eventFields(e)])]);

  await q("delete from public.jobs");
  const orders = [
    [older, newer, older],
    [newer, older, newer, newer],
  ];
  const results: unknown[] = [];
  for (const order of orders) {
    const ws = await workspace();
    const src = await keySource(ws, `rk_test_order${results.length}abcdefg`, []);
    await q("update public.sources set status = 'live' where id = $1", [src]);
    let stored = 0;
    for (const e of order) {
      stored += (await record(src, e)).n;
      await drain(() => h, ["stripe.sync_object", "mrr.rebuild_customer"]);
    }
    assert.equal(stored, 2, "each event stored once, however often it came");
    // A backfill page fetched before the sync, written after it, can't undo the newer copy.
    await upsertRows(pool, { id: src, workspace_id: ws }, "subscriptions", [subscriptionRow(sub(1))], "2020-01-01T00:00:00Z");
    results.push(
      await one(
        `select (select jsonb_agg(jsonb_build_object('id', id, 'type', type, 'changed', changed, 'processed', processed_at is not null) order by id) from public.stripe_events where source_id = $1) as events,
                (select jsonb_agg(raw order by id) from public.stripe_subscriptions where source_id = $1) as subs,
                (select jsonb_agg(jsonb_build_object('id', id, 'quantity', quantity) order by id) from public.stripe_subscription_items where source_id = $1) as items,
                (select jsonb_agg(jsonb_build_object('day', day, 'kind', kind, 'amount', amount) order by day, kind) from public.mrr_movements where source_id = $1) as movements`,
        [src],
      ),
    );
  }
  assert.deepEqual(results[0], results[1], "same rows whatever the order");
  const r = results[0] as { items: { quantity: number }[]; movements: { amount: number }[] };
  assert.equal(r.items[0]!.quantity, 3, "the state Stripe has now, not the event's copy");
  assert.ok(r.movements.length > 0, "the customer was rebuilt");
});

const eventFields = (e: Obj) => eventRow(parseEvent(e)!);

// ---------- poll ----------

test("poll_events reads events after the last one, saves its place, and falls back to time when Stripe forgot the id", async () => {
  const ws = await workspace();
  const src = await keySource(ws, "rk_test_poll000000001", []);
  await q("update public.sources set status = 'live', last_event_id = 'evt_p0', last_event_at = to_timestamp(1770000000) where id = $1", [src]);
  const events = [evt("evt_p3", 1770000300, 3), evt("evt_p2", 1770000200, 2), evt("evt_p1", 1770000100, 1)];
  let forget = false;
  const s = fakeFetch((u) => {
    assert.equal(u.pathname, "/v1/events");
    const before = u.searchParams.get("ending_before");
    if (before) {
      if (forget) return json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such event" } }, 400);
      // The events just newer than `before`, newest first, `limit` at a time.
      const i = before === "evt_p0" ? events.length : events.findIndex((e) => e.id === before);
      const limit = 2;
      const data = events.slice(Math.max(0, i - limit), i);
      return list(data, i - limit > 0);
    }
    assert.ok(Number(u.searchParams.get("created[gte]")) <= 1770000300, "from the last event's time");
    return list(events);
  });
  const h = makeHandlers({ db: pool, fetch: s.fetch, retry: FAST, log: () => {}, now: () => 1770000400_000 });
  const job = (): Job => ({ id: "x", workspace_id: ws, kind: "stripe.poll_events", key: src, payload: { source_id: src }, attempts: 1, max_attempts: 5 });
  await h["stripe.poll_events"]!(job(), signal);
  const row = await one<{ last_event_id: string; synced: boolean; n: string; jobs: string }>(
    `select last_event_id, last_synced_at is not null as synced, (select count(*) from public.stripe_events where source_id = $1)::text as n,
            (select count(*) from public.jobs where kind = 'stripe.sync_object' and key = $1 || ':sub_ooo' and status = 'queued')::text as jobs
       from public.sources where id = $1`,
    [src],
  );
  assert.equal(row.last_event_id, "evt_p3");
  assert.equal(row.n, "3");
  assert.equal(row.jobs, "1", "one sync for the object");
  assert.ok(row.synced);
  assert.deepEqual(
    s.calls.map((c) => c.url.searchParams.get("ending_before")),
    ["evt_p0", "evt_p2"],
    "pages toward newer events, from the newest seen",
  );

  forget = true;
  await h["stripe.poll_events"]!(job(), signal);
  assert.equal((await one<{ n: string }>("select count(*)::text as n from public.stripe_events where source_id = $1", [src])).n, "3", "nothing doubled");
  assert.equal((await one<{ last_event_id: string }>("select last_event_id from public.sources where id = $1", [src])).last_event_id, "evt_p3");
});

// ---------- the whole import over every fixture ----------

type Fixture = { name: string; currency: string; asOf: string; stripe: Obj & { customer: Obj }; fx: { day: string; base: string; quote: string; rate: string }[]; expected: { mrr: number; movements: { day: string; kind: string; amount: number; cause: { type: string; id: string } }[] } };
const FIXTURES = readdirSync(join(import.meta.dirname, "..", "fixtures", "stripe"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "stripe", f), "utf8")) as Fixture);

const byNewest = (xs: Obj[]) => [...xs].sort((a, b) => Number(b.created ?? 0) - Number(a.created ?? 0) || String(b.id).localeCompare(String(a.id)));

/** Stripe answering for one fixture's account. */
function fixtureStripe(fx: Fixture) {
  const st = fx.stripe as Record<string, Obj[]> & { customer: Obj };
  const subs = st.subscriptions ?? [];
  const invoices = st.invoices ?? [];
  const charges = st.charges ?? [];
  const refunds = st.refunds ?? [];
  const find = (xs: Obj[], id: string) => xs.find((x) => x.id === id);
  const missing = () => json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, 404);
  const expandCharge = (r: Obj) => ({ ...r, charge: find(charges, String(r.charge)) ?? r.charge });
  return (u: URL): Response => {
    const p = u.pathname;
    const expand = u.searchParams.getAll("expand[]");
    if (p === "/v1/products") return page([], u);
    if (p === "/v1/prices") return page(byNewest(st.prices ?? []), u);
    if (p === "/v1/coupons") return page(byNewest(st.coupons ?? []), u);
    if (p === "/v1/customers") return page([st.customer], u);
    if (p === "/v1/subscriptions") {
      const all = u.searchParams.get("status") === "all" ? subs : subs.filter((s) => s.status !== "canceled" && s.status !== "incomplete_expired");
      return page(byNewest(all), u);
    }
    if (p === "/v1/invoices") {
      const gte = Number(u.searchParams.get("created[gte]") ?? -Infinity);
      const lt = Number(u.searchParams.get("created[lt]") ?? Infinity);
      return page(byNewest(invoices.filter((i) => Number(i.created) >= gte && Number(i.created) < lt)), u);
    }
    if (p === "/v1/charges") return page(byNewest(charges), u);
    if (p === "/v1/refunds") {
      const ch = u.searchParams.get("charge");
      const rs = byNewest(refunds.filter((r) => !ch || r.charge === ch));
      return page(expand.includes("data.charge") ? rs.map(expandCharge) : rs, u);
    }
    if (p === "/v1/events") return page(byNewest(st.events ?? []), u);
    const m = /^\/v1\/(customers|subscriptions|invoices|charges|refunds|prices)\/([^/]+)$/.exec(p);
    if (m) {
      const id = decodeURIComponent(m[2]!);
      const pool: Record<string, Obj[]> = { customers: [st.customer], subscriptions: subs, invoices, charges, refunds, prices: st.prices ?? [] };
      const o = find(pool[m[1]!]!, id);
      if (!o) return missing();
      return json(m[1] === "refunds" && expand.includes("charge") ? expandCharge(o) : o);
    }
    const lines = /^\/v1\/invoices\/([^/]+)\/lines$/.exec(p);
    if (lines) return page(((find(invoices, decodeURIComponent(lines[1]!))?.lines as { data: Obj[] }) ?? { data: [] }).data, u);
    if (p === "/v1/subscription_items") return page(((find(subs, u.searchParams.get("subscription")!)?.items as { data: Obj[] }) ?? { data: [] }).data, u);
    return missing();
  };
}

test("the whole import over every fixture: backfill, finish, poll and sync give the hand-worked movements, and the source goes live", async () => {
  const bySource = new Map<string, { fx: Fixture; ws: string }>();
  const handlersByWs = new Map<string, Record<string, Handler>>();
  const answer = new Map<string, (u: URL) => Response>();
  await q("delete from public.jobs");
  const s = fakeFetch((u, c) => answer.get(c.auth.replace("Bearer ", ""))!(u));
  for (const [i, fx] of FIXTURES.entries()) {
    for (const r of fx.fx) await q("insert into public.fx_rates (base, quote, day, rate) values ($1, $2, $3, $4) on conflict do nothing", [r.base, r.quote, r.day, r.rate]);
    const ws = await workspace(fx.currency);
    const key = `rk_test_fixture${String(i).padStart(6, "0")}`;
    const src = await keySource(ws, key, [...BACKFILL_OBJECTS], `acct_fixture${i}`);
    bySource.set(src, { fx, ws });
    answer.set(key, fixtureStripe(fx));
    // Older invoices are those more than a year before "now": 300 days after the fixture's day, so both halves run.
    const now = Date.parse(`${fx.asOf}T12:00:00Z`) + 300 * 86_400_000;
    handlersByWs.set(ws, makeHandlers({ db: pool, fetch: s.fetch, retry: FAST, log: () => {}, today: () => fx.asOf, now: () => now }));
  }
  const ran = await drain((job) => handlersByWs.get(job.workspace_id!)!, ["stripe.backfill", "stripe.backfill_finish", "stripe.poll_events", "stripe.sync_object", "mrr.rebuild_customer"]);
  assert.deepEqual(
    Object.keys(ran).filter((k) => !k.endsWith(":done")),
    [],
    `every job finished: ${JSON.stringify(ran)}`,
  );
  assert.ok(ran["stripe.backfill_finish:done"]! >= FIXTURES.length);
  const leftover = await q("select kind, key, last_error from public.jobs where status = 'queued' and workspace_id is not null");
  assert.deepEqual(leftover, [], "nothing left waiting (no customer was deferred)");

  for (const [src, { fx, ws }] of bySource) {
    const row = await one<{ status: string; backfill: Record<string, { done?: boolean }> }>("select status, backfill from public.sources where id = $1", [src]);
    assert.equal(row.status, "live", `${fx.name}: live`);
    for (const o of [...BACKFILL_OBJECTS, "invoices_older"]) assert.equal(row.backfill[o]?.done, true, `${fx.name}: ${o} done`);
    const movements = await q<{ day: string; kind: string; amount: string; cause_type: string; cause_id: string }>(
      "select day::text as day, kind, amount::text as amount, cause_type, cause_id from public.mrr_movements where source_id = $1 order by day, at, id",
      [src],
    );
    assert.deepEqual(
      movements.map((m) => ({ day: m.day, kind: m.kind, amount: Number(m.amount), cause: { type: m.cause_type, id: m.cause_id } })),
      fx.expected.movements.map((m) => ({ day: m.day, kind: m.kind, amount: m.amount, cause: m.cause })),
      `${fx.name}: movements`,
    );
    const counts = await one<{ inv: string; lines: string; refunds_with_customer: string; refunds: string }>(
      `select (select count(*) from public.stripe_invoices where source_id = $1)::text as inv,
              (select count(*) from public.stripe_invoice_lines where source_id = $1)::text as lines,
              (select count(*) from public.stripe_refunds where source_id = $1 and customer_id is not null)::text as refunds_with_customer,
              (select count(*) from public.stripe_refunds where source_id = $1)::text as refunds`,
      [src],
    );
    const st = fx.stripe as Record<string, Obj[]>;
    assert.equal(Number(counts.inv), (st.invoices ?? []).length, `${fx.name}: every invoice`);
    assert.equal(Number(counts.lines), (st.invoices ?? []).reduce((n, i) => n + ((i.lines as { data: unknown[] }).data.length), 0), `${fx.name}: every line`);
    assert.equal(counts.refunds_with_customer, counts.refunds, `${fx.name}: refunds carry their charge's customer`);
    const daily = await one<{ mrr: string } | undefined>("select mrr::text as mrr from public.mrr_daily where workspace_id = $1 and day = $2::date", [ws, fx.asOf]);
    assert.equal(Number(daily?.mrr ?? 0), fx.expected.mrr, `${fx.name}: mrr_daily on ${fx.asOf}`);
  }

  // The nightly check agrees with every customer; a stored MRR that drifted is caught and rebuilt.
  const [src0, { fx: fx0, ws: ws0 }] = [...bySource.entries()].find(([, v]) => v.fx.expected.mrr > 0)!;
  const h0 = handlersByWs.get(ws0)!;
  const check = (): Job => ({ id: "x", workspace_id: ws0, kind: "stripe.check", key: "", payload: { source_id: src0 }, attempts: 1, max_attempts: 5 });
  const logs: string[] = [];
  const hLog = makeHandlers({ db: pool, fetch: s.fetch, retry: FAST, log: (m) => logs.push(m), today: () => fx0.asOf });
  await hLog["stripe.check"]!(check(), signal);
  assert.ok(logs.some((l) => / 0 rebuilt$/.test(l)), `nothing off: ${logs.join(" | ")}`);
  await q("update public.mrr_customer_days set mrr = mrr + 5000 where source_id = $1 and to_day is null", [src0]);
  logs.length = 0;
  await hLog["stripe.check"]!(check(), signal);
  assert.ok(logs.some((l) => /off -5000 cents\); rebuilding/.test(l)), logs.join(" | "));
  assert.equal((await one<{ n: string }>("select count(*)::text as n from public.jobs where kind = 'mrr.rebuild_customer' and key like $1 || ':%' and status = 'queued'", [src0])).n, "1");
  await drain(() => h0, ["mrr.rebuild_customer"]);
  const fixed = await one<{ mrr: string }>("select mrr::text as mrr from public.mrr_customer_days where source_id = $1 and to_day is null", [src0]);
  assert.equal(Number(fixed.mrr), fx0.expected.mrr, "rebuilt to the right number");
});

// ---------- delete, rates ----------

test("deleting a source mid-import: its jobs find nothing and stop quietly", async () => {
  const ws = await workspace();
  await q("delete from public.jobs");
  const src = await keySource(ws, "rk_test_gone000000001", ["customers"]);
  const [job] = await q<Job>("select * from public.claim_job(array['stripe.backfill'], 'w-gone', 30, 1)");
  await q("select public.delete_source($1)", [src]);
  const s = fakeFetch(() => json({}, 500));
  assert.equal(await runJob(pgRpc(pool), "w-gone", job!, makeHandlers({ db: pool, fetch: s.fetch, retry: FAST, log: () => {} })["stripe.backfill"], 30), "done");
  assert.equal(s.calls.length, 0, "Stripe never called");
});

test("fx.load: the first load takes 90 days and the history, later loads the daily file", async () => {
  await q("delete from public.fx_rates");
  const xml = (days: [string, string][]) =>
    `<?xml version="1.0"?><gesmes:Envelope><Cube>${days.map(([d, r]) => `<Cube time='${d}'><Cube currency='USD' rate='${r}'/><Cube currency='GBP' rate='0.8'/></Cube>`).join("")}</Cube></gesmes:Envelope>`;
  const files: Record<string, string> = {
    "/stats/eurofxref/eurofxref-hist-90d.xml": xml([["2026-11-10", "1.1214"], ["2026-11-09", "1.12"]]),
    "/stats/eurofxref/eurofxref-hist.xml": xml([["2026-11-10", "1.1214"], ["2026-11-09", "1.12"], ["1999-01-04", "1.1789"]]),
    "/stats/eurofxref/eurofxref-daily.xml": xml([["2026-11-11", "1.13"]]),
  };
  const s = fakeFetch((u) => (files[u.pathname] ? new Response(files[u.pathname], { headers: { "Content-Type": "text/xml" } }) : new Response("", { status: 404 })));
  const h = makeHandlers({ db: pool, fetch: s.fetch, retry: FAST, log: () => {} });
  const job: Job = { id: "x", workspace_id: null, kind: "fx.load", key: "d", payload: {}, attempts: 1, max_attempts: 5 };
  await h["fx.load"]!(job, signal);
  assert.deepEqual(s.calls.map((c) => c.url.pathname.split("/").pop()), ["eurofxref-hist-90d.xml", "eurofxref-hist.xml"]);
  assert.equal((await one<{ n: string }>("select count(*)::text as n from public.fx_rates")).n, "6");
  assert.equal((await one<{ rate: string }>("select rate::text as rate from public.fx_rates where base = 'eur' and quote = 'usd' and day = '1999-01-04'")).rate, "1.1789");
  await h["fx.load"]!(job, signal);
  assert.equal(s.calls.at(-1)!.url.pathname.split("/").pop(), "eurofxref-daily.xml");
  assert.equal((await one<{ n: string }>("select count(*)::text as n from public.fx_rates")).n, "8");
});
