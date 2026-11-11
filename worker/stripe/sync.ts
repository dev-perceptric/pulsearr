// Keeping a source current (docs/m1-plan.md section 2).
//
//   stripe.sync_object  payload { source_id, object_type, object_id }, key `${source_id}:${object_id}`
//     Fetch the object fresh from Stripe (never the event's copy), write it with its items, lines or refunds, mark
//     its events processed, and enqueue mrr.rebuild_customer for its customer. Two copies of an event, or events in
//     the wrong order, end in the same rows: the last fetch wins. A deleted customer is marked deleted; a deleted
//     (draft) invoice is removed; a deleted price, product or coupon is kept, since past invoices still name it.
//   stripe.poll_events  payload { source_id }, key `${source_id}`; every 5 minutes per source (worker/schedule.ts)
//     Read /v1/events newer than sources.last_event_id (ending_before, a page at a time, saving the newest id after
//     each page), and store and enqueue each like the webhook. With no last id, or one Stripe no longer has (events
//     are kept 30 days), from last_event_at, or from when the source was connected.
//   stripe.check        payload { source_id }, key `${source_id}:${day}`; nightly
//     Fetch every subscription Stripe still has open, write them, and work out each customer's MRR today from the
//     fresh rows. A customer whose stored MRR (mrr_customer_days) is off by more than 100 cents is logged and rebuilt.

import { JobError, type Job } from "../../src/lib/jobs.ts";
import { buildCustomer, fromStripe } from "../../src/lib/mrr/index.ts";
import { eventRow, isSyncType, parseEvent, PAGE_LIMIT, StripeError, type StripeList, type StripeObject } from "../../src/lib/stripe/index.ts";
import { loadCustomer } from "../mrr.ts";
import type { Db } from "../pg.ts";
import { enqueueRebuilds, loadSource, sourceClient, stripeFailure, type Source, type StripeDeps } from "./source.ts";
import {
  customersOf,
  refundCustomers,
  storeCharges,
  storeCoupons,
  storeCustomers,
  storeInvoices,
  storePrices,
  storeProducts,
  storeRefunds,
  storeSubscriptions,
  type Ctx,
} from "./store.ts";

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const DAY_S = 86_400;
/** Stripe keeps events this long. */
const EVENTS_KEPT_S = 30 * DAY_S;
/** MRR differences up to this many cents are rounding, not drift. */
export const CHECK_TOLERANCE = 100;

const missing = (e: unknown) => e instanceof StripeError && e.missing;
const live = (s: Source | null): s is Source => !!s && s.status !== "disconnected" && s.status !== "error";

export async function runSyncObject(deps: StripeDeps, job: Pick<Job, "payload">, signal: AbortSignal): Promise<{ customers: string[] } | null> {
  const type = job.payload.object_type;
  const id = str(job.payload.object_id);
  if (!isSyncType(type) || !id || id.length > 255) throw new JobError(`stripe.sync_object: bad payload ${JSON.stringify(job.payload)}`, { retry: false });
  const source = await loadSource(deps.db, job.payload.source_id);
  if (!live(source)) return null;
  const startedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const stripe = sourceClient(deps, source, signal);
  const ctx: Ctx = { db: deps.db, source, stripe };
  const path = (p: string) => `${p}/${encodeURIComponent(id)}`;
  const customers: string[] = [];
  const at = startedAt;
  try {
    switch (type) {
      case "customer": {
        let c: Obj;
        try {
          c = await stripe.get(path("/v1/customers"));
        } catch (e) {
          if (!missing(e)) throw e;
          c = { id, object: "customer", deleted: true };
        }
        if (c.deleted === true) {
          await deps.db.query(
            `insert into public.stripe_customers (source_id, workspace_id, id, deleted, raw, updated_at) values ($1, $2, $3, true, $4::jsonb, $5::timestamptz)
             on conflict (source_id, id) do update set deleted = true, updated_at = excluded.updated_at`,
            [source.id, source.workspace_id, id, JSON.stringify(c), at],
          );
        } else await storeCustomers(ctx, [c], at);
        customers.push(id);
        break;
      }
      case "subscription": {
        const s = await stripe.get(path("/v1/subscriptions"), { expand: ["discounts"] });
        await storeSubscriptions(ctx, [s], at);
        customers.push(...customersOf([s]));
        break;
      }
      case "invoice": {
        try {
          const inv = await stripe.get(path("/v1/invoices"), { expand: ["discounts"] });
          await storeInvoices(ctx, [inv], at);
          customers.push(...customersOf([inv]));
        } catch (e) {
          if (!missing(e)) throw e;
          // A draft that was deleted: gone from Stripe, so gone here (its lines go with it).
          const { rows } = await deps.db.query<{ customer_id: string }>("delete from public.stripe_invoices where source_id = $1 and id = $2 returning customer_id", [source.id, id]);
          customers.push(...rows.map((r) => r.customer_id));
        }
        break;
      }
      case "charge": {
        const ch = await stripe.get(path("/v1/charges"));
        await storeCharges(ctx, [ch], at);
        const customer = customersOf([ch])[0] ?? null;
        const refunds = await stripe.listAll("/v1/refunds", { charge: id });
        await storeRefunds(ctx, refunds, at, customer);
        if (customer) customers.push(customer);
        break;
      }
      case "refund": {
        const r = await stripe.get(path("/v1/refunds"), { expand: ["charge"] });
        await storeRefunds(ctx, [r], at);
        customers.push(...refundCustomers([r]));
        break;
      }
      case "price":
      case "product":
      case "coupon": {
        // Kept when deleted: past invoices and discounts still name them. They don't change anyone's MRR.
        try {
          const o = await stripe.get(path(type === "price" ? "/v1/prices" : type === "product" ? "/v1/products" : "/v1/coupons"));
          await (type === "price" ? storePrices : type === "product" ? storeProducts : storeCoupons)(ctx, [o], at);
        } catch (e) {
          if (!missing(e)) throw e;
        }
        break;
      }
    }
  } catch (e) {
    if (signal.aborted) throw e;
    if (missing(e)) {
      (deps.log ?? console.log)(`stripe.sync_object ${type} ${id}: not in Stripe, nothing to write`);
      return { customers: [] };
    }
    await stripeFailure(deps.db, source, e, `stripe.sync_object ${type}`);
  }
  await deps.db.query("update public.stripe_events set processed_at = now() where source_id = $1 and object_id = $2 and processed_at is null and received_at <= $3::timestamptz", [
    source.id,
    id,
    startedAt,
  ]);
  await enqueueRebuilds(deps.db, source, customers);
  return { customers: [...new Set(customers)] };
}

// ---------- events ----------

/** Store events (newest first, as Stripe lists them) oldest first, and enqueue their syncs. Returns how many were new. */
export async function recordEvents(db: Db, sourceId: string, events: Obj[]): Promise<number> {
  const rows = events
    .map(parseEvent)
    .filter((e): e is NonNullable<typeof e> => !!e)
    .map(eventRow)
    .sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1));
  if (!rows.length) return 0;
  const { rows: out } = await db.query<{ n: number }>("select public.record_stripe_events($1, $2::jsonb) as n", [sourceId, JSON.stringify(rows)]);
  return Number(out[0]?.n ?? 0);
}

async function saveWatermark(db: Db, sourceId: string, e: Obj) {
  await db.query("update public.sources set last_event_id = $2, last_event_at = to_timestamp($3), updated_at = now() where id = $1", [sourceId, str(e.id), Number(e.created) || 0]);
}

export async function runPollEvents(deps: StripeDeps, job: Pick<Job, "payload">, signal: AbortSignal): Promise<{ seen: number; stored: number } | null> {
  const source = await loadSource(deps.db, job.payload.source_id);
  if (!source || (source.status !== "importing" && source.status !== "live")) return null;
  const nowS = Math.floor((deps.now ?? Date.now)() / 1000);
  const stripe = sourceClient(deps, source, signal);
  let seen = 0;
  let stored = 0;
  try {
    let after = source.last_event_id;
    if (after) {
      try {
        for (;;) {
          if (signal.aborted) throw signal.reason;
          const page: StripeList<StripeObject> = await stripe.get<StripeList<StripeObject>>("/v1/events", { limit: PAGE_LIMIT, ending_before: after });
          if (!page.data.length) break;
          seen += page.data.length;
          stored += await recordEvents(deps.db, source.id, page.data);
          await saveWatermark(deps.db, source.id, page.data[0]!);
          after = page.data[0]!.id!;
          if (!page.has_more) break;
        }
      } catch (e) {
        if (!missing(e)) throw e;
        after = null; // older than Stripe keeps: read by time instead
      }
    }
    if (!after) {
      const fromAt = source.last_event_at ? Date.parse(source.last_event_at) / 1000 : Date.parse(source.created_at) / 1000 - 60;
      const since = Math.max(Math.floor(fromAt) - 60, nowS - EVENTS_KEPT_S);
      const events = await stripe.listAll("/v1/events", { created: { gte: since } }, 50_000);
      seen += events.length;
      for (let i = events.length; i > 0; i -= PAGE_LIMIT) stored += await recordEvents(deps.db, source.id, events.slice(Math.max(0, i - PAGE_LIMIT), i));
      if (events[0]) await saveWatermark(deps.db, source.id, events[0]);
    }
  } catch (e) {
    if (signal.aborted) throw e;
    await stripeFailure(deps.db, source, e, "stripe.poll_events");
  }
  await deps.db.query("update public.sources set last_synced_at = now(), updated_at = now() where id = $1", [source.id]);
  return { seen, stored };
}

// ---------- nightly check ----------

export type CheckResult = { checked: number; off: { customer: string; ours: number; stripe: number }[] };

export async function runCheck(deps: StripeDeps & { today: () => string }, job: Pick<Job, "payload">, signal: AbortSignal): Promise<CheckResult | null> {
  const source = await loadSource(deps.db, job.payload.source_id);
  if (!source || source.status !== "live") return null;
  const log = deps.log ?? console.log;
  const today = deps.today();
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  const stripe = sourceClient(deps, source, signal);
  const ctx: Ctx = { db: deps.db, source, stripe };
  const candidates = new Set<string>();
  try {
    // Every subscription Stripe hasn't canceled, fresh.
    const open = await stripe.listAll("/v1/subscriptions", { expand: ["data.discounts"] }, 200_000);
    await storeSubscriptions(ctx, open, at);
    for (const c of customersOf(open)) candidates.add(c);
    // Ours that Stripe no longer lists as open: fetch each, it changed without our hearing.
    const openIds = open.map((s) => str(s.id)).filter((x): x is string => !!x);
    const { rows: stale } = await deps.db.query<{ id: string; customer_id: string }>(
      "select id, customer_id from public.stripe_subscriptions where source_id = $1 and status not in ('canceled', 'incomplete_expired') and not (id = any($2::text[]))",
      [source.id, openIds],
    );
    for (const s of stale) {
      if (signal.aborted) throw signal.reason;
      try {
        await storeSubscriptions(ctx, [await stripe.get(`/v1/subscriptions/${encodeURIComponent(s.id)}`, { expand: ["discounts"] })], at);
      } catch (e) {
        if (!missing(e)) throw e;
      }
      candidates.add(s.customer_id);
    }
  } catch (e) {
    if (signal.aborted) throw e;
    await stripeFailure(deps.db, source, e, "stripe.check");
  }
  const { rows: current } = await deps.db.query<{ customer_id: string; mrr: string }>(
    "select customer_id, mrr::text as mrr from public.mrr_customer_days where source_id = $1 and to_day is null",
    [source.id],
  );
  const ours = new Map(current.map((r) => [r.customer_id, Number(r.mrr)]));
  for (const [c, m] of ours) if (m > 0) candidates.add(c);

  const off: CheckResult["off"] = [];
  for (const customer of [...candidates].sort()) {
    if (signal.aborted) throw signal.reason;
    let theirs: number;
    try {
      const loaded = await loadCustomer(deps.db, source.workspace_id, source.id, customer, today);
      if (!loaded) return null;
      theirs = buildCustomer(fromStripe(loaded.stripe, { currency: loaded.currency, asOf: today, fx: loaded.fx, customerId: customer })).mrr;
    } catch (e) {
      log(`stripe.check ${customer}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const mine = ours.get(customer) ?? 0;
    if (Math.abs(theirs - mine) > CHECK_TOLERANCE) off.push({ customer, ours: mine, stripe: theirs });
  }
  for (const o of off) log(`stripe.check ${source.id} ${o.customer}: ours ${o.ours}, Stripe ${o.stripe} (off ${o.stripe - o.ours} cents); rebuilding`);
  await enqueueRebuilds(deps.db, source, off.map((o) => o.customer));
  return { checked: candidates.size, off };
}
