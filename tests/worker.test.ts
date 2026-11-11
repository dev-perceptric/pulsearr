import assert from "node:assert/strict";
import { test } from "node:test";
import { EmailError, type Email, type SendResult } from "../src/lib/email.ts";
import { JobError, runJob, type Job, type Rpc } from "../src/lib/jobs.ts";
import { makeHandlers } from "../worker/handlers.ts";
import { pgRpc, rpcSql, type Db } from "../worker/pg.ts";
import { tickOnce } from "../worker/tick.ts";
import { rebuildCustomer } from "../worker/mrr.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INVITE = "22222222-2222-4222-8222-222222222222";
const job = (payload: Record<string, unknown> = { invite_id: INVITE }): Job => ({ id: "j1", workspace_id: "w", kind: "email.invite", key: INVITE, payload, attempts: 1, max_attempts: 5 });
const signal = new AbortController().signal;

function fakeDb(rows: Record<string, unknown>[]) {
  const queries: { text: string; params?: unknown[] }[] = [];
  const db: Db = {
    query: async <R>(text: string, params?: unknown[]) => {
      queries.push({ text, params });
      return { rows: rows as R[] };
    },
  };
  return { db, queries };
}

function fakeSend(answer: (e: Email) => SendResult | Error = () => ({ id: "em_1" })) {
  const sent: Email[] = [];
  const send = async (e: Email) => {
    sent.push(e);
    const a = answer(e);
    if (a instanceof Error) throw a;
    return a;
  };
  return { send, sent };
}

test("email.invite sends the invite once, keyed by the invite id", async () => {
  const { db, queries } = fakeDb([{ id: INVITE, email: "ada@example.com", workspace_name: "Acme", inviter_email: "lin@acme.com" }]);
  const { send, sent } = fakeSend();
  await makeHandlers({ db, send, appUrl: "https://app.pulsearr.com" })["email.invite"]!(job(), signal);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, "ada@example.com");
  assert.equal(sent[0]!.idempotencyKey, INVITE);
  assert.equal(sent[0]!.subject, "Join Acme on PulseARR");
  assert.ok(sent[0]!.text.includes("lin@acme.com invited you"));
  assert.ok(sent[0]!.html.includes("https://app.pulsearr.com/signin"));
  assert.deepEqual(queries[0]!.params, [INVITE]);
  assert.match(queries[0]!.text, /from public\.invites i\s+join public\.workspaces w/);
});

test("email.invite for an invite that's gone finishes without sending", async () => {
  const { db } = fakeDb([]);
  const { send, sent } = fakeSend();
  await makeHandlers({ db, send })["email.invite"]!(job(), signal);
  assert.equal(sent.length, 0);
});

test("a refused address stops retrying; a busy Resend goes back to the queue", async () => {
  const { db } = fakeDb([{ id: INVITE, email: "bad", workspace_name: "Acme", inviter_email: null }]);
  const refused = fakeSend(() => new EmailError("Resend answered 422: Invalid `to` field", 422, false));
  await assert.rejects(makeHandlers({ db, send: refused.send })["email.invite"]!(job(), signal), (e: unknown) => e instanceof JobError && !e.retry);
  const busy = fakeSend(() => new EmailError("Resend answered 503", 503, true));
  await assert.rejects(makeHandlers({ db, send: busy.send })["email.invite"]!(job(), signal), (e: unknown) => e instanceof EmailError && !(e instanceof JobError));
});

test("a bad invite_id fails without retrying or querying", async () => {
  const { db, queries } = fakeDb([]);
  await assert.rejects(makeHandlers({ db, send: fakeSend().send })["email.invite"]!(job({ invite_id: "x';drop" }), signal), (e: unknown) => e instanceof JobError && !e.retry);
  assert.equal(queries.length, 0);
});

test("the whole job runs through the queue over the pg adapter", async () => {
  const calls: { text: string; params?: unknown[] }[] = [];
  const db: Db = {
    query: async <R>(text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (text.includes("finish_job")) return { rows: [{ finish_job: true }] as R[], fields: [{ name: "finish_job" }] };
      return { rows: [{ id: INVITE, email: "ada@example.com", workspace_name: "Acme", inviter_email: null }] as R[] };
    },
  };
  const { send, sent } = fakeSend();
  const result = await runJob(pgRpc(db), "w1", job(), makeHandlers({ db, send })["email.invite"], 300);
  assert.equal(result, "done");
  assert.equal(sent.length, 1);
  const finish = calls.find((c) => c.text.includes("finish_job"))!;
  assert.equal(finish.text, "select * from public.finish_job(p_id => $1, p_worker => $2, p_ok => $3, p_error => $4, p_retry_s => $5)");
  assert.deepEqual(finish.params, ["j1", "w1", true, null, null]);
});

test("rpcSql uses named arguments, sends objects as JSON and refuses odd names", () => {
  assert.deepEqual(rpcSql("enqueue_job", { p_workspace: null, p_kind: "email.invite", p_payload: { invite_id: "x" }, p_kinds: ["a", "b"], p_skip: undefined }), {
    text: "select * from public.enqueue_job(p_workspace => $1, p_kind => $2, p_payload => $3, p_kinds => $4)",
    values: [null, "email.invite", '{"invite_id":"x"}', ["a", "b"]],
  });
  assert.throws(() => rpcSql("x; drop table jobs", {}));
  assert.throws(() => rpcSql("finish_job", { "p_id) or 1=1 --": 1 }));
});

test("pgRpc answers one value for a scalar function, rows for a set, and errors as { error }", async () => {
  const answers: Record<string, { rows: Record<string, unknown>[]; fields: { name: string }[] }> = {
    extend_job: { rows: [{ extend_job: false }], fields: [{ name: "extend_job" }] },
    claim_job: { rows: [], fields: [{ name: "id" }, { name: "kind" }] },
  };
  const db: Db = {
    query: async <R>(text: string) => {
      const fn = /public\.(\w+)\(/.exec(text)![1]!;
      if (fn === "boom") throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      return answers[fn] as unknown as { rows: R[]; fields: { name: string }[] };
    },
  };
  const rpc: Rpc = pgRpc(db);
  assert.deepEqual(await rpc("extend_job", { p_id: "j1" }), { data: false, error: null });
  assert.deepEqual(await rpc("claim_job", { p_kinds: ["email.invite"] }), { data: [], error: null });
  assert.deepEqual(await rpc("boom", {}), { data: null, error: { message: "deadlock detected", code: "40P01" } });
});

test("the tick prunes old jobs and logs the queue only when there's something to say", async () => {
  const logs: string[] = [];
  const db: Db = {
    query: async <R>(text: string) => {
      if (text.includes("prune_jobs")) return { rows: [{ n: 3 }] as R[] };
      return { rows: [{ status: "queued", n: "2" }] as R[] };
    },
  };
  assert.deepEqual(await tickOnce(db, (m) => logs.push(m)), { pruned: 3, counts: { queued: 2 } });
  assert.deepEqual(logs, ["tick: pruned 3, queued 2, running 0"]);
  const quiet: Db = { query: async <R>(text: string) => ({ rows: (text.includes("prune_jobs") ? [{ n: 0 }] : []) as R[] }) };
  logs.length = 0;
  await tickOnce(quiet, (m) => logs.push(m));
  assert.deepEqual(logs, []);
});

// ---------- mrr.rebuild_customer ----------

const WS = "33333333-3333-4333-8333-333333333333";
const SRC = "44444444-4444-4444-8444-444444444444";
type StripeFixture = { name: string; currency: string; asOf: string; stripe: Record<string, Record<string, unknown>[] & Record<string, unknown>>; fx: Record<string, string>[]; expected: { movements: { day: string; kind: string; amount: number; cause: { type: string; id: string } }[]; feed: unknown[] } };
const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "stripe", `${name}.json`), "utf8")) as StripeFixture;

/** A database holding one fixture's rows in the clean tables, answering the loader's queries by table. */
function stripeDb(fx: StripeFixture, o: { sourceGone?: boolean; noRates?: boolean; order?: <T>(xs: T[]) => T[] } = {}) {
  const s = fx.stripe as unknown as Record<string, Record<string, unknown>[]> & { customer: Record<string, unknown> };
  const order = o.order ?? (<T>(xs: T[]) => xs);
  const calls: { text: string; params?: unknown[] }[] = [];
  const raw = (xs: unknown[]) => ({ rows: order(xs.map((x) => ({ raw: x }))) });
  const db: Db = {
    query: async <R>(text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      const table = /from public\.(\w+)/.exec(text)?.[1];
      let out: { rows: unknown[] };
      if (text.includes("replace_customer_mrr")) out = { rows: [{ changed: "2026-01-01" }] };
      else if (table === "workspaces") out = { rows: o.sourceGone ? [] : [{ currency: fx.currency }] };
      else if (table === "stripe_customers") out = raw([s.customer]);
      else if (table === "stripe_subscriptions") out = raw(s.subscriptions);
      else if (table === "stripe_invoices") out = raw(s.invoices);
      else if (table === "stripe_charges") out = raw(s.charges);
      else if (table === "stripe_refunds") out = raw(s.refunds);
      else if (table === "stripe_subscription_items") out = raw(s.subscriptions.flatMap((x) => (x.items as { data: unknown[] }).data));
      else if (table === "stripe_invoice_lines") out = { rows: [] };
      else if (table === "stripe_prices") out = raw(s.prices.filter((p) => (params[1] as string[]).includes(p.id as string)));
      else if (table === "stripe_coupons") out = raw(s.coupons.filter((c) => (params[1] as string[]).includes(c.id as string)));
      else if (table === "stripe_events") {
        out = {
          rows: order(
            s.events.map((e) => {
              const data = e.data as { object: { id: string }; previous_attributes?: Record<string, unknown> };
              return { id: e.id, type: e.type, created: String(e.created), object_id: data.object.id, changed: data.previous_attributes ? Object.keys(data.previous_attributes) : null };
            }),
          ),
        };
      } else if (table === "fx_rates") out = { rows: o.noRates ? [] : fx.fx };
      else throw new Error(`unexpected query: ${text}`);
      return out as { rows: R[] };
    },
  };
  const replace = () => calls.find((c) => c.text.includes("replace_customer_mrr"));
  return { db, calls, replace };
}
const mrrJob = (payload: Record<string, unknown>): Job => ({ id: "j2", workspace_id: WS, kind: "mrr.rebuild_customer", key: `${SRC}:cus_seats`, payload, attempts: 1, max_attempts: 5 });

test("mrr.rebuild_customer builds the customer and replaces its rows in one call", async () => {
  const fx = fixture("seat_quantity_change");
  const { db, replace } = stripeDb(fx);
  await makeHandlers({ db, today: () => fx.asOf, log: () => undefined })["mrr.rebuild_customer"]!(mrrJob({ workspace_id: WS, source_id: SRC, customer_id: "cus_seats" }), signal);
  const call = replace()!;
  assert.equal(call.text, "select public.replace_customer_mrr($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)::text as changed");
  const [ws, src, cus, movements, days, feed] = call.params as [string, string, string, string, string, string];
  assert.deepEqual([ws, src, cus], [WS, SRC, "cus_seats"]);
  const rows = JSON.parse(movements) as Record<string, unknown>[];
  assert.deepEqual(
    rows.map((m) => ({ day: m.day, kind: m.kind, amount: m.amount, cause: { type: m.cause_type, id: m.cause_id } })),
    fx.expected.movements,
  );
  assert.deepEqual(rows[2], {
    subscription_id: "sub_seats", day: "2026-04-20", at: "2026-04-20T09:30:00.000Z", kind: "contraction", amount: -2000, mrr_before: 8000, mrr_after: 6000,
    currency: "usd", original_amount: -2000, original_currency: "usd", rate: "1", cause_type: "event", cause_id: "evt_seats_2",
  });
  assert.deepEqual(JSON.parse(days).at(-1), { from_day: "2026-04-20", to_day: null, mrr: 6000, mrr_native: 6000, native_currency: "usd", rate: "1" });
  assert.equal((JSON.parse(feed) as unknown[]).length, fx.expected.feed.length);
});

test("mrr.rebuild_customer loads rates only for another currency, from before the customer's first object", async () => {
  const fx = fixture("euro_customer_usd_workspace");
  const { db, calls, replace } = stripeDb(fx);
  const out = await rebuildCustomer(db, { workspace_id: WS, source_id: SRC, customer_id: "cus_eur" }, fx.asOf);
  assert.deepEqual(out, { skipped: false, changedFrom: "2026-01-01", movements: 3, mrr: 0 });
  const rates = calls.find((c) => c.text.includes("fx_rates"))!;
  assert.deepEqual(rates.params, [["eur", "usd"], "2026-01-23", "2026-05-31"]);
  const rows = JSON.parse((replace()!.params as string[])[3]!) as { rate: string; amount: number; original_amount: number }[];
  assert.deepEqual(rows.map((r) => [r.amount, r.original_amount, r.rate]), [[5326, 4900, "1.087"], [5376, 4900, "1.092"], [-10702, -9800, "1.099"]]);
  // A dollar customer never asks for rates.
  const usd = stripeDb(fixture("two_subscriptions"));
  await rebuildCustomer(usd.db, { workspace_id: WS, source_id: SRC, customer_id: "cus_two" }, "2026-05-10");
  assert.ok(!usd.calls.some((c) => c.text.includes("fx_rates")));
});

test("mrr.rebuild_customer waits for missing rates without writing, and stops on a bad payload", async () => {
  const fx = fixture("euro_customer_usd_workspace");
  const { db, replace } = stripeDb(fx, { noRates: true });
  await assert.rejects(rebuildCustomer(db, { workspace_id: WS, source_id: SRC, customer_id: "cus_eur" }, fx.asOf), (e: unknown) => e instanceof JobError && e.retry && e.retryAfterS === 3600 && /No EUR to USD rate/.test(e.message));
  assert.equal(replace(), undefined);
  for (const bad of [{ workspace_id: WS, source_id: SRC, customer_id: "cus_x'; drop" }, { workspace_id: "nope", source_id: SRC, customer_id: "cus_a" }, { source_id: SRC, customer_id: "cus_a" }]) {
    const b = stripeDb(fx);
    await assert.rejects(rebuildCustomer(b.db, bad, fx.asOf), (e: unknown) => e instanceof JobError && !e.retry);
    assert.equal(b.calls.length, 0);
  }
});

test("mrr.rebuild_customer for a source that's gone does nothing", async () => {
  const fx = fixture("seat_quantity_change");
  const { db, calls, replace } = stripeDb(fx, { sourceGone: true });
  const logs: string[] = [];
  await makeHandlers({ db, today: () => fx.asOf, log: (m) => logs.push(m) })["mrr.rebuild_customer"]!(mrrJob({ workspace_id: WS, source_id: SRC, customer_id: "cus_seats" }), signal);
  assert.equal(calls.length, 1);
  assert.equal(replace(), undefined);
  assert.deepEqual(logs, ["mrr.rebuild_customer cus_seats: source gone, nothing to do"]);
});

test("mrr.rebuild_customer writes the same rows 50 times with the database's rows in any order", async () => {
  for (const name of ["unpaid_31_days_then_paid", "seat_quantity_change", "euro_customer_usd_workspace"]) {
    const fx = fixture(name);
    const cus = (fx.stripe as unknown as { customer: { id: string } }).customer.id;
    const first = stripeDb(fx);
    await rebuildCustomer(first.db, { workspace_id: WS, source_id: SRC, customer_id: cus }, fx.asOf);
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const order = <T>(xs: T[]) => {
      const out = [...xs, ...xs.filter(() => rand() < 0.4)];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    };
    for (let i = 0; i < 50; i++) {
      const again = stripeDb(fx, { order });
      await rebuildCustomer(again.db, { workspace_id: WS, source_id: SRC, customer_id: cus }, fx.asOf);
      assert.deepEqual(again.replace()!.params, first.replace()!.params, `${name} run ${i + 1}`);
    }
  }
});

test("mrr.rebuild_customer runs through the queue and finishes the job", async () => {
  const fx = fixture("seat_quantity_change");
  const { db, calls } = stripeDb(fx);
  const queue: Db = {
    query: async <R>(text: string, params?: unknown[]) => {
      if (text.includes("finish_job")) return { rows: [{ finish_job: true }] as R[], fields: [{ name: "finish_job" }] };
      return db.query<R>(text, params);
    },
  };
  const result = await runJob(pgRpc(queue), "w1", mrrJob({ workspace_id: WS, source_id: SRC, customer_id: "cus_seats" }), makeHandlers({ db: queue, today: () => fx.asOf })["mrr.rebuild_customer"], 300);
  assert.equal(result, "done");
  assert.ok(calls.some((c) => c.text.includes("replace_customer_mrr")));
});
