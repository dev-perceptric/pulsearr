// mrr.rebuild_customer: rebuild one Stripe customer's MRR from the clean tables (docs/m1-plan.md section 3).
// Payload { workspace_id, source_id, customer_id }. Enqueue it with key `${source_id}:${customer_id}`, so a burst
// of events for one customer runs once and never twice at the same time.
//
// Loads the customer's raw Stripe rows (customer, subscriptions and items, invoices and lines, charges, refunds,
// the prices and coupons they name, its subscription events and the currency rates it needs), runs the engine,
// and hands the rows to replace_customer_mrr, which swaps the customer's movements, days and feed items in one
// transaction and rebuilds mrr_daily from the earliest day that changed.

import { buildCustomer, feedItems, fromStripe, MissingDataError, MissingRateError, referencedIds, type BuildResult, type FeedItem, type FxRate, type StripeData } from "../src/lib/mrr/index.ts";
import { JobError } from "../src/lib/jobs.ts";
import type { Db } from "./pg.ts";

type Obj = Record<string, unknown>;
type RawRow = { raw: Obj };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER = /^cus_[A-Za-z0-9]+$/;
/** How far before a customer's first object to load rates, so the first day can fall back to an earlier one. */
const RATE_SLACK_DAYS = 10;

export type Loaded = { currency: string; stripe: StripeData; fx: FxRate[] };

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Everything the engine needs for one customer, or null when the source is gone (its rows went with it). */
export async function loadCustomer(db: Db, ws: string, source: string, customer: string, today: string): Promise<Loaded | null> {
  const head = await db.query<{ currency: string }>(
    "select w.currency from public.workspaces w join public.sources s on s.workspace_id = w.id where w.id = $1 and s.id = $2",
    [ws, source],
  );
  if (!head.rows[0]) return null;
  const currency = head.rows[0].currency.toLowerCase();
  const raws = async (sql: string, params: unknown[]) => (await db.query<RawRow>(sql, params)).rows.map((r) => r.raw);

  const [customers, subscriptions, invoices, charges] = await Promise.all([
    raws("select raw from public.stripe_customers where source_id = $1 and id = $2", [source, customer]),
    raws("select raw from public.stripe_subscriptions where source_id = $1 and customer_id = $2", [source, customer]),
    raws("select raw from public.stripe_invoices where source_id = $1 and customer_id = $2", [source, customer]),
    raws("select raw from public.stripe_charges where source_id = $1 and customer_id = $2", [source, customer]),
  ]);
  const subIds = subscriptions.map((s) => str(s.id)).filter((x): x is string => !!x).sort();
  const invoiceIds = invoices.map((i) => str(i.id)).filter((x): x is string => !!x).sort();
  const chargeIds = charges.map((c) => str(c.id)).filter((x): x is string => !!x).sort();

  const [subscriptionItems, lineRows, refunds, eventRows] = await Promise.all([
    raws("select raw from public.stripe_subscription_items where source_id = $1 and subscription_id = any($2)", [source, subIds]),
    db.query<{ invoice_id: string; raw: Obj }>("select invoice_id, raw from public.stripe_invoice_lines where source_id = $1 and invoice_id = any($2)", [source, invoiceIds]),
    raws("select raw from public.stripe_refunds where source_id = $1 and (customer_id = $2 or charge_id = any($3))", [source, customer, chargeIds]),
    db.query<{ id: string; type: string; created: string | number; object_id: string; changed: string[] | null }>(
      "select id, type, extract(epoch from created)::bigint as created, object_id, changed from public.stripe_events where source_id = $1 and object_id = any($2) and type like 'customer.subscription.%'",
      [source, subIds],
    ),
  ]);
  const stripe: StripeData = {
    customer: customers[0] ?? null,
    subscriptions,
    subscriptionItems,
    invoices,
    invoiceLines: lineRows.rows.map((r) => ({ invoiceId: r.invoice_id, line: r.raw })),
    charges,
    refunds,
    // Rebuilt in Stripe's event shape: which fields changed is all the engine reads.
    events: eventRows.rows.map((e) => ({
      id: e.id,
      object: "event",
      type: e.type,
      created: Number(e.created),
      data: { object: { id: e.object_id }, ...(e.changed ? { previous_attributes: Object.fromEntries(e.changed.map((k) => [k, null])) } : {}) },
    })),
  };
  const ids = referencedIds(stripe);
  const [prices, coupons] = await Promise.all([
    ids.prices.length ? raws("select raw from public.stripe_prices where source_id = $1 and id = any($2)", [source, ids.prices]) : Promise.resolve([]),
    ids.coupons.length ? raws("select raw from public.stripe_coupons where source_id = $1 and id = any($2)", [source, ids.coupons]) : Promise.resolve([]),
  ]);
  stripe.prices = prices;
  stripe.coupons = coupons;

  // Rates only when the customer bills in another currency: from just before its first object through today.
  const objects = [...subscriptions, ...invoices, ...charges, ...refunds];
  const currencies = new Set(objects.map((o) => str(o.currency)?.toLowerCase()).filter((c): c is string => !!c && c !== currency));
  const custCurrency = str(customers[0]?.currency)?.toLowerCase();
  if (custCurrency && custCurrency !== currency) currencies.add(custCurrency);
  let fx: FxRate[] = [];
  if (currencies.size) {
    const first = Math.min(...objects.map((o) => (typeof o.created === "number" ? o.created : Infinity)), Date.parse(`${today}T00:00:00Z`) / 1000);
    const from = new Date((first - RATE_SLACK_DAYS * 86_400) * 1000).toISOString().slice(0, 10);
    const all = [...new Set([...currencies, currency, "eur"])].sort();
    fx = (
      await db.query<FxRate>("select base, quote, day::text as day, rate::text as rate from public.fx_rates where base = any($1) and quote = any($1) and day between $2::date and $3::date", [all, from, today])
    ).rows;
  }
  return { currency, stripe, fx };
}

const iso = (t: number) => new Date(t * 1000).toISOString();

/** The rows replace_customer_mrr takes, with its column names. */
export function replaceArgs(result: BuildResult, feed: FeedItem[]) {
  return {
    movements: result.movements.map((m) => ({
      subscription_id: m.subscriptionId,
      day: m.day,
      at: iso(m.at),
      kind: m.kind,
      amount: m.amount,
      mrr_before: m.mrrBefore,
      mrr_after: m.mrrAfter,
      currency: m.currency,
      original_amount: m.originalAmount,
      original_currency: m.originalCurrency,
      rate: m.rate,
      cause_type: m.cause.type,
      cause_id: m.cause.id,
    })),
    days: result.days.map((d) => ({ from_day: d.from, to_day: d.to, mrr: d.mrr, mrr_native: d.mrrNative, native_currency: d.nativeCurrency, rate: d.rate })),
    feed: feed.map((f) => ({
      key: f.key,
      kind: f.kind,
      at: iso(f.at),
      amount: f.amount,
      currency: f.currency,
      original_amount: f.originalAmount,
      original_currency: f.originalCurrency,
      object_type: f.objectType,
      object_id: f.objectId,
    })),
  };
}

export type RebuildOutcome = { skipped: true } | { skipped: false; changedFrom: string | null; movements: number; mrr: number };

/**
 * Rebuild one customer. Throws JobError for a bad payload (no retry) and for missing rates or prices (later).
 * With `daily: false` mrr_daily is left alone: the backfill rebuilds it once after every customer.
 */
export async function rebuildCustomer(db: Db, payload: Record<string, unknown>, today: string, opts: { daily?: boolean } = {}): Promise<RebuildOutcome> {
  const ws = String(payload.workspace_id ?? "");
  const source = String(payload.source_id ?? "");
  const customer = String(payload.customer_id ?? "");
  if (!UUID.test(ws) || !UUID.test(source) || !CUSTOMER.test(customer)) {
    throw new JobError(`mrr.rebuild_customer: bad payload ${JSON.stringify({ workspace_id: ws, source_id: source, customer_id: customer })}`, { retry: false });
  }
  const loaded = await loadCustomer(db, ws, source, customer, today);
  if (!loaded) return { skipped: true };
  let result: BuildResult;
  let feed: FeedItem[];
  try {
    const input = fromStripe(loaded.stripe, { currency: loaded.currency, asOf: today, fx: loaded.fx, customerId: customer });
    result = buildCustomer(input);
    feed = feedItems(input, result);
  } catch (e) {
    // Rates load nightly and prices sync on their own: try again later, using an attempt.
    if (e instanceof MissingRateError) throw new JobError(`mrr.rebuild_customer ${customer}: ${e.message}`, { retryAfterS: 3600 });
    if (e instanceof MissingDataError) throw new JobError(`mrr.rebuild_customer ${customer}: ${e.message}`, { retryAfterS: 600 });
    throw e;
  }
  const args = replaceArgs(result, feed);
  const daily = opts.daily ?? true;
  const { rows } = await db.query<{ changed: string | null }>(
    daily
      ? "select public.replace_customer_mrr($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)::text as changed"
      : "select public.replace_customer_mrr($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, false)::text as changed",
    [ws, source, customer, JSON.stringify(args.movements), JSON.stringify(args.days), JSON.stringify(args.feed)],
  );
  return { skipped: false, changedFrom: rows[0]?.changed ?? null, movements: result.movements.length, mrr: result.mrr };
}
