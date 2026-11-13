// stripe.backfill: load a source's history, one job per object type (docs/m1-plan.md section 2).
// Payload { source_id, object }, key `${source_id}:${object}`; connect_source enqueues one per BACKFILL_OBJECTS.
//
// Each page of 100 is written (upserts, so a page written twice leaves one row each), then its last id is saved as
// the cursor in sources.backfill[object]. A job that loses its lease, or a worker that stops, picks up after the
// last saved page. Invoices load the last 12 months first; when they're done, `invoices_older` loads the rest.
//
// When every object type in BACKFILL_OBJECTS is done, stripe.backfill_finish rebuilds every customer once (first
// numbers on the dashboard); when the older invoices are done too, it runs again (final) and the source goes live.
// stripe.backfill_finish (payload { source_id, final }, key `${source_id}`) rebuilds customers in id order without
// touching mrr_daily, saving its place every 50 in sources.backfill.rebuild ({ run, cursor, customers, done }; no
// `count`, so it never reads as an object type), then rebuilds mrr_daily once. A customer that can't be built yet
// (a missing rate or price) gets its own mrr.rebuild_customer job, which retries on its own schedule.
//
// Test mode: Stripe leaves customers, subscriptions and invoices on test clocks out of its lists unless the call
// names the clock. So in a test-mode source, once the plain list is done, those types list the source's test clocks
// once (sources.backfill[object].clocks) and go through them one at a time (.clock), each with its own cursor. A key
// that can't read test clocks (403) just skips them.

import { enqueueJob, JobError, type Job } from "../../src/lib/jobs.ts";
import { BACKFILL_OBJECTS, OLDER_INVOICES, PAGE_LIMIT, type BackfillObject, type StripeList, type StripeObject } from "../../src/lib/stripe/index.ts";
import { rebuildCustomer } from "../mrr.ts";
import { pgRpc, type Db } from "../pg.ts";
import { StripeError } from "../../src/lib/stripe/client.ts";
import { loadSource, sourceClient, stripeFailure, type BackfillState, type Source, type StripeDeps } from "./source.ts";
import { storeCharges, storeCoupons, storeCustomers, storeInvoices, storePrices, storeProducts, storeRefunds, storeSubscriptions, type Ctx } from "./store.ts";

type Obj = Record<string, unknown>;
const YEAR_S = 365 * 86_400;

type Spec = { path: string; params: (state: BackfillState) => Record<string, unknown>; store: (c: Ctx, objs: Obj[], at: string) => Promise<number> };

export const SPECS: Record<BackfillObject, Spec> = {
  products: { path: "/v1/products", params: () => ({}), store: storeProducts },
  prices: { path: "/v1/prices", params: () => ({}), store: storePrices },
  coupons: { path: "/v1/coupons", params: () => ({}), store: storeCoupons },
  customers: { path: "/v1/customers", params: () => ({}), store: storeCustomers },
  subscriptions: { path: "/v1/subscriptions", params: () => ({ status: "all", expand: ["data.discounts"] }), store: storeSubscriptions },
  invoices: { path: "/v1/invoices", params: (s) => ({ created: { gte: s.boundary }, expand: ["data.discounts"] }), store: storeInvoices },
  [OLDER_INVOICES]: { path: "/v1/invoices", params: (s) => ({ created: { lt: s.boundary }, expand: ["data.discounts"] }), store: storeInvoices },
  charges: { path: "/v1/charges", params: () => ({}), store: storeCharges },
  refunds: { path: "/v1/refunds", params: () => ({ expand: ["data.charge"] }), store: (c, objs, at) => storeRefunds(c, objs, at) },
};

/** The types Stripe hides on test clocks unless the list names the clock. */
const CLOCKED = new Set<string>(["customers", "subscriptions", "invoices", OLDER_INVOICES]);

async function testClocks(stripe: Ctx["stripe"]): Promise<string[]> {
  try {
    const clocks = await stripe.listAll("/v1/test_helpers/test_clocks", {}, 10_000);
    return clocks.map((c) => c.id).filter((id): id is string => typeof id === "string").sort();
  } catch (e) {
    if (e instanceof StripeError && (e.status === 403 || e.status === 404)) return [];
    throw e;
  }
}

const isBackfillObject = (v: unknown): v is BackfillObject => typeof v === "string" && Object.hasOwn(SPECS, v);

/** Merge one object type's state into sources.backfill. One UPDATE, so two jobs finishing at once both land. */
export async function saveState(db: Db, sourceId: string, object: string, state: BackfillState): Promise<Record<string, BackfillState> | null> {
  const { rows } = await db.query<{ backfill: Record<string, BackfillState> }>(
    "update public.sources set backfill = backfill || jsonb_build_object($2::text, $3::jsonb), updated_at = now() where id = $1 returning backfill",
    [sourceId, object, JSON.stringify(state)],
  );
  return rows[0]?.backfill ?? null;
}

const done = (b: Record<string, BackfillState> | null, o: string) => b?.[o]?.done === true;

export async function runBackfill(deps: StripeDeps, job: Pick<Job, "payload">, signal: AbortSignal): Promise<{ pages: number; rows: number } | null> {
  const object = job.payload.object;
  if (!isBackfillObject(object)) throw new JobError(`stripe.backfill: unknown object ${JSON.stringify(object)}`, { retry: false });
  const source = await loadSource(deps.db, job.payload.source_id);
  if (!source || source.status === "disconnected" || source.status === "error") return null;
  const now = deps.now ?? Date.now;
  const spec = SPECS[object];
  let state: BackfillState = { ...(source.backfill[object] ?? {}) };
  let pages = 0;
  let rows = 0;

  if (!state.done) {
    // The line between recent and older invoices is set once and kept, so both halves agree after a restart.
    if (object === "invoices" && typeof state.boundary !== "number") state.boundary = Math.floor(now() / 1000) - YEAR_S;
    if (object === OLDER_INVOICES && typeof state.boundary !== "number") {
      const b = source.backfill.invoices?.boundary;
      if (typeof b !== "number") throw new JobError("stripe.backfill: older invoices before the recent ones", { retryAfterS: 300 });
      state.boundary = b;
    }
    const stripe = sourceClient(deps, source, signal);
    const ctx: Ctx = { db: deps.db, source, stripe };
    try {
      for (;;) {
        if (signal.aborted) throw signal.reason;
        const fetchedAt = new Date(now()).toISOString();
        const clock = state.clock ? { test_clock: state.clock } : {};
        let page: StripeList<StripeObject>;
        try {
          page = await stripe.get<StripeList<StripeObject>>(spec.path, { limit: PAGE_LIMIT, ...spec.params(state), ...clock, starting_after: state.cursor ?? undefined });
        } catch (e) {
          // A test clock deleted after it was listed: nothing left on it.
          if (!(state.clock && e instanceof StripeError && e.missing)) throw e;
          page = { object: "list", data: [], has_more: false };
        }
        rows += await spec.store(ctx, page.data, fetchedAt);
        pages++;
        // The lease was lost while this page was written: the job's next run writes it again (upserts) from the last cursor.
        if (signal.aborted) throw signal.reason;
        const last = page.data.at(-1)?.id;
        state = { ...state, cursor: last ?? state.cursor ?? null, count: (state.count ?? 0) + page.data.length, done: !page.has_more || !last };
        if (state.done && !source.livemode && CLOCKED.has(object)) {
          const clocks = state.clocks ?? (await testClocks(stripe));
          const next = clocks[state.clock ? clocks.indexOf(state.clock) + 1 : 0];
          state = next ? { ...state, clocks, clock: next, cursor: null, done: false } : { ...state, clocks };
        }
        if (state.done) state.finished_at = new Date(now()).toISOString();
        await saveState(deps.db, source.id, object, state);
        if (state.done) break;
      }
    } catch (e) {
      if (signal.aborted) throw e;
      await stripeFailure(deps.db, source, e, `stripe.backfill ${object}`);
    }
  }

  // Also runs when a restarted job finds its type already done, so nothing that follows is ever skipped.
  const rpc = pgRpc(deps.db);
  if (object === "invoices") {
    await enqueueJob(rpc, { workspaceId: source.workspace_id, kind: "stripe.backfill", key: `${source.id}:${OLDER_INVOICES}`, payload: { source_id: source.id, object: OLDER_INVOICES } });
  }
  const now2 = (await loadSource(deps.db, source.id))?.backfill ?? null;
  const base = BACKFILL_OBJECTS.every((o) => done(now2, o));
  if (base) {
    const final = done(now2, OLDER_INVOICES);
    await enqueueJob(rpc, { workspaceId: source.workspace_id, kind: "stripe.backfill_finish", key: source.id, payload: { source_id: source.id, final } });
  }
  return { pages, rows };
}

/** Every customer the source has rows for, after `after`, in id order. */
async function customersAfter(db: Db, sourceId: string, after: string | null, limit: number): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select id from (
       select id from public.stripe_customers where source_id = $1
       union select customer_id from public.stripe_subscriptions where source_id = $1
       union select customer_id from public.stripe_invoices where source_id = $1
       union select customer_id from public.stripe_charges where source_id = $1 and customer_id is not null
     ) x where id like 'cus\\_%' and ($2::text is null or id collate "C" > $2::text collate "C") order by id collate "C" limit $3`,
    [sourceId, after, limit],
  );
  return rows.map((r) => r.id);
}

export async function runBackfillFinish(deps: StripeDeps & { today: () => string }, job: Pick<Job, "payload">, signal: AbortSignal): Promise<{ customers: number; deferred: number } | null> {
  const source: Source | null = await loadSource(deps.db, job.payload.source_id);
  if (!source || source.status === "disconnected" || source.status === "error") return null;
  const log = deps.log ?? console.log;
  const run = job.payload.final === true ? "final" : "first";
  const prev = source.backfill.rebuild;
  let cursor = prev && prev.run === run && !prev.done ? (prev.cursor ?? null) : null;
  let count = prev && prev.run === run && !prev.done ? (prev.customers ?? 0) : 0;
  let deferred = 0;
  const today = deps.today();
  for (;;) {
    if (signal.aborted) throw signal.reason;
    const batch = await customersAfter(deps.db, source.id, cursor, 50);
    if (!batch.length) break;
    for (const customer of batch) {
      if (signal.aborted) throw signal.reason;
      try {
        const out = await rebuildCustomer(deps.db, { workspace_id: source.workspace_id, source_id: source.id, customer_id: customer }, today, { daily: false });
        if (out.skipped) return null; // the source was removed meanwhile
      } catch (e) {
        // One customer that can't be built yet never stops the rest: it retries as its own job.
        deferred++;
        log(`stripe.backfill_finish ${customer}: ${e instanceof Error ? e.message : String(e)}; queued on its own`);
        await enqueueJob(pgRpc(deps.db), {
          workspaceId: source.workspace_id,
          kind: "mrr.rebuild_customer",
          key: `${source.id}:${customer}`,
          payload: { workspace_id: source.workspace_id, source_id: source.id, customer_id: customer },
          delayS: e instanceof JobError && e.retryAfterS ? e.retryAfterS : 60,
        });
      }
    }
    cursor = batch.at(-1)!;
    count += batch.length;
    await saveState(deps.db, source.id, "rebuild", { run, cursor, customers: count, done: false });
  }
  await deps.db.query("select public.rebuild_mrr_daily($1, null)", [source.workspace_id]);
  await saveState(deps.db, source.id, "rebuild", { run, cursor: null, customers: count, done: true, finished_at: new Date((deps.now ?? Date.now)()).toISOString() });
  if (run === "final") {
    await deps.db.query("update public.sources set status = 'live', last_error = null, updated_at = now() where id = $1 and status = 'importing'", [source.id]);
  }
  return { customers: count, deferred };
}
