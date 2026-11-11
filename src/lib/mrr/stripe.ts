// Stripe API objects to the engine's input. Takes the objects as Stripe returns them (the `raw` column of the clean
// tables): API versions up to 2024 (line.price, line.subscription, line.proration, invoice.subscription) and from
// 2025 (line.pricing.price_details.price, line.parent.subscription_item_details, invoice.parent.subscription_details,
// discount.source.coupon). Prices, coupons and discounts embedded anywhere are picked up, so an expanded object
// never needs its own row. Repeats and order don't matter: the engine keeps one copy per id.

import type { Charge, Coupon, Discount, FxRate, Invoice, InvoiceLine, MrrInput, Price, Refund, Subscription, SubscriptionItem, SubscriptionUpdate, Tier } from "./types.ts";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const idOf = (v: unknown): string | null => str(v) ?? (isObj(v) ? str(v.id) : null);
const get = (v: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : isObj(v) && Array.isArray(v.data) ? v.data : []);
const lower = (v: unknown, fallback = ""): string => (str(v) ?? fallback).toLowerCase();
const decimalText = (dec: unknown, whole: unknown): string | null => str(dec) ?? (num(whole) != null ? String(num(whole)) : null);

export type StripeData = {
  customer?: Obj | null;
  subscriptions?: Obj[];
  /** Subscription items stored on their own (stripe_subscription_items), for subscriptions with more than Stripe lists inline. */
  subscriptionItems?: Obj[];
  invoices?: Obj[];
  /** Invoice lines stored on their own (stripe_invoice_lines), for invoices with more lines than Stripe lists inline. */
  invoiceLines?: { invoiceId: string; line: Obj }[];
  prices?: Obj[];
  coupons?: Obj[];
  charges?: Obj[];
  refunds?: Obj[];
  /** customer.subscription.* events, for when each subscription last changed. */
  events?: Obj[];
};

const UPDATE_EVENTS = new Set(["customer.subscription.updated", "customer.subscription.paused", "customer.subscription.resumed", "customer.subscription.pending_update_applied"]);

export function mapPrice(p: Obj): Price {
  const isPlan = p.object === "plan";
  const rec = isPlan ? p : isObj(p.recurring) ? p.recurring : null;
  const interval = str(rec?.interval);
  const recurring =
    rec && interval && (isPlan || p.type !== "one_time") && ["day", "week", "month", "year"].includes(interval)
      ? { interval: interval as "day" | "week" | "month" | "year", intervalCount: num(rec.interval_count) ?? 1, usageType: rec.usage_type === "metered" ? ("metered" as const) : ("licensed" as const) }
      : null;
  const tiers: Tier[] = list(p.tiers)
    .filter(isObj)
    .map((t) => ({ upTo: num(t.up_to), unitAmount: decimalText(t.unit_amount_decimal, t.unit_amount), flatAmount: decimalText(t.flat_amount_decimal, t.flat_amount) }));
  const tq = isObj(p.transform_quantity) ? p.transform_quantity : null;
  return {
    id: str(p.id) ?? "",
    currency: lower(p.currency, "usd"),
    productId: idOf(p.product),
    unitAmount: isPlan ? decimalText(p.amount_decimal, p.amount) : decimalText(p.unit_amount_decimal, p.unit_amount),
    billingScheme: p.billing_scheme === "tiered" ? "tiered" : "per_unit",
    tiersMode: p.tiers_mode === "volume" ? "volume" : p.tiers_mode === "graduated" ? "graduated" : null,
    tiers,
    recurring,
    transformQuantity: tq && num(tq.divide_by) ? { divideBy: num(tq.divide_by)!, round: tq.round === "down" ? "down" : "up" } : null,
  };
}

export function mapCoupon(c: Obj): Coupon {
  const duration = c.duration === "forever" ? "forever" : c.duration === "repeating" ? "repeating" : "once";
  const products = list(get(c, "applies_to", "products")).map(idOf).filter((x): x is string => !!x);
  return {
    id: str(c.id) ?? "",
    percentOff: num(c.percent_off) != null ? String(num(c.percent_off)) : null,
    amountOff: num(c.amount_off),
    currency: str(c.currency)?.toLowerCase() ?? null,
    duration,
    appliesTo: products.length ? products : null,
  };
}

export function fromStripe(data: StripeData, opts: { currency: string; asOf: string; fx?: FxRate[]; customerId?: string }): MrrInput {
  const customerId = opts.customerId ?? str(data.customer?.id) ?? idOf(data.subscriptions?.[0]?.customer) ?? idOf(data.invoices?.[0]?.customer) ?? "";
  const mine = (o: Obj) => {
    const c = idOf(o.customer);
    return c == null || c === customerId;
  };
  const prices: Price[] = [];
  const coupons: Coupon[] = [];
  const discounts: Discount[] = [];

  const takePrice = (v: unknown): string | null => {
    if (isObj(v) && (v.object === "price" || v.object === "plan")) prices.push(mapPrice(v));
    return idOf(v);
  };
  const takeDiscount = (v: unknown) => {
    if (!isObj(v) || v.object !== "discount") return;
    const coupon = v.coupon ?? get(v, "source", "coupon");
    if (isObj(coupon)) coupons.push(mapCoupon(coupon));
    const couponId = idOf(coupon);
    const start = num(v.start);
    if (!couponId || start == null) return;
    const subId = idOf(v.subscription);
    discounts.push({
      id: str(v.id) ?? `${couponId}:${start}`,
      couponId,
      scope: subId ? "subscription" : idOf(v.invoice) || idOf(v.invoice_item) ? "invoice" : "customer",
      subscriptionId: subId,
      start,
      end: num(v.end),
    });
  };

  for (const p of data.prices ?? []) prices.push(mapPrice(p));
  for (const c of data.coupons ?? []) coupons.push(mapCoupon(c));
  if (data.customer) takeDiscount(data.customer.discount);

  const updates = new Map<string, SubscriptionUpdate[]>();
  for (const e of data.events ?? []) {
    const type = str(e.type);
    const subId = idOf(get(e, "data", "object"));
    const at = num(e.created);
    if (!type || !UPDATE_EVENTS.has(type) || !subId || at == null) continue;
    const prev = get(e, "data", "previous_attributes");
    const u = { at, fields: isObj(prev) ? Object.keys(prev).sort() : null, eventId: str(e.id) ?? `${type}:${at}` };
    updates.set(subId, [...(updates.get(subId) ?? []), u]);
  }

  const extraItems = new Map<string, Obj[]>();
  for (const it of data.subscriptionItems ?? []) {
    const s = idOf(it.subscription);
    if (s) extraItems.set(s, [...(extraItems.get(s) ?? []), it]);
  }
  const subscriptions: Subscription[] = [];
  for (const s of data.subscriptions ?? []) {
    if (!mine(s) || !str(s.id)) continue;
    const id = str(s.id)!;
    takeDiscount(s.discount);
    for (const d of list(s.discounts)) takeDiscount(d);
    // The inline list is the truth when it's complete; otherwise add the stored items.
    const inline = list(s.items).filter(isObj);
    const all = get(s, "items", "has_more") === true ? [...inline, ...(extraItems.get(id) ?? [])] : inline.length ? inline : (extraItems.get(id) ?? []);
    const seen = new Map<string, SubscriptionItem>();
    for (const it of all) {
      const itemId = str(it.id);
      const priceId = takePrice(it.price ?? it.plan);
      if (!itemId || !priceId || it.deleted === true) continue;
      seen.set(itemId, { id: itemId, priceId, quantity: num(it.quantity) ?? 1 });
    }
    const items = [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const pc = isObj(s.pause_collection) ? s.pause_collection : null;
    subscriptions.push({
      id,
      currency: lower(s.currency, items[0] ? (prices.find((p) => p.id === items[0]!.priceId)?.currency ?? opts.currency) : opts.currency),
      status: str(s.status) ?? "active",
      created: num(s.created) ?? 0,
      startDate: num(s.start_date),
      trialStart: num(s.trial_start),
      trialEnd: num(s.trial_end),
      endedAt: num(s.ended_at),
      canceledAt: num(s.canceled_at),
      pauseCollection: pc ? { behavior: str(pc.behavior) ?? "void", resumesAt: num(pc.resumes_at) } : null,
      items,
      updates: updates.get(id) ?? [],
    });
  }

  const extraLines = new Map<string, Obj[]>();
  for (const { invoiceId, line } of data.invoiceLines ?? []) extraLines.set(invoiceId, [...(extraLines.get(invoiceId) ?? []), line]);
  const invoices: Invoice[] = [];
  for (const inv of data.invoices ?? []) {
    const id = str(inv.id);
    if (!id || !mine(inv)) continue;
    const created = num(inv.created) ?? 0;
    const subId = idOf(inv.subscription) ?? idOf(get(inv, "parent", "subscription_details", "subscription"));
    takeDiscount(inv.discount);
    for (const d of list(inv.discounts)) takeDiscount(d);
    const lines: InvoiceLine[] = [];
    for (const l of [...list(inv.lines).filter(isObj), ...(extraLines.get(id) ?? [])]) {
      const lineId = str(l.id);
      if (!lineId) continue;
      for (const d of list(l.discounts)) takeDiscount(d);
      const parent = get(l, "parent");
      const si = get(parent, "subscription_item_details");
      const ii = get(parent, "invoice_item_details");
      const isSub = l.type === "subscription" || get(parent, "type") === "subscription_item_details";
      const per = get(l, "period");
      lines.push({
        id: lineId,
        kind: isSub ? "subscription" : "invoiceitem",
        subscriptionId: idOf(l.subscription) ?? idOf(get(si, "subscription")) ?? idOf(get(ii, "subscription")) ?? subId,
        subscriptionItemId: idOf(l.subscription_item) ?? idOf(get(si, "subscription_item")),
        priceId: takePrice(l.price ?? l.plan) ?? idOf(get(l, "pricing", "price_details", "price")),
        quantity: num(l.quantity) ?? 1,
        amount: num(l.amount) ?? 0,
        discount: list(l.discount_amounts).reduce<number>((acc, d) => acc + (num(get(d, "amount")) ?? 0), 0),
        proration: l.proration === true || get(si, "proration") === true || get(ii, "proration") === true,
        periodStart: num(get(per, "start")) ?? created,
        periodEnd: num(get(per, "end")) ?? created,
      });
    }
    const status = str(inv.status);
    const transitions = get(inv, "status_transitions");
    invoices.push({
      id,
      subscriptionId: subId,
      status: status === "open" || status === "paid" || status === "uncollectible" || status === "void" ? status : "draft",
      currency: lower(inv.currency, opts.currency),
      created,
      dueAt: num(inv.due_date) ?? num(get(transitions, "finalized_at")) ?? created,
      paidAt: num(get(transitions, "paid_at")),
      amountDue: num(inv.amount_due) ?? 0,
      lines,
    });
  }

  const charges: Charge[] = (data.charges ?? []).filter(mine).flatMap((c) => {
    const id = str(c.id);
    const status = c.status === "succeeded" || c.status === "failed" ? c.status : "pending";
    return id ? [{ id, created: num(c.created) ?? 0, amount: num(c.amount) ?? 0, currency: lower(c.currency, opts.currency), status, invoiceId: idOf(c.invoice) }] : [];
  });
  const refunds: Refund[] = (data.refunds ?? []).flatMap((r) => {
    const id = str(r.id);
    return id ? [{ id, created: num(r.created) ?? 0, amount: num(r.amount) ?? 0, currency: lower(r.currency, opts.currency), status: str(r.status) ?? "succeeded", chargeId: idOf(r.charge) }] : [];
  });

  return {
    customerId,
    currency: opts.currency.toLowerCase(),
    asOf: opts.asOf,
    subscriptions,
    invoices,
    prices,
    coupons,
    discounts,
    charges,
    refunds,
    fx: opts.fx ?? [],
  };
}

/** The ids of every price and coupon the objects name, so a loader can fetch just those rows. */
export function referencedIds(data: StripeData): { prices: string[]; coupons: string[] } {
  const prices = new Set<string>();
  const coupons = new Set<string>();
  const discount = (d: unknown) => {
    const c = idOf(get(d, "coupon") ?? get(d, "source", "coupon"));
    if (c) coupons.add(c);
  };
  for (const s of data.subscriptions ?? []) {
    discount(s.discount);
    list(s.discounts).forEach(discount);
    for (const it of list(s.items)) {
      const p = idOf(get(it, "price") ?? get(it, "plan"));
      if (p) prices.add(p);
    }
  }
  for (const it of data.subscriptionItems ?? []) {
    const p = idOf(it.price ?? it.plan);
    if (p) prices.add(p);
  }
  const line = (l: unknown) => {
    const p = idOf(get(l, "price") ?? get(l, "plan")) ?? idOf(get(l, "pricing", "price_details", "price"));
    if (p) prices.add(p);
    list(get(l, "discounts")).forEach(discount);
  };
  for (const inv of data.invoices ?? []) {
    discount(inv.discount);
    list(inv.discounts).forEach(discount);
    list(inv.lines).forEach(line);
  }
  for (const { line: l } of data.invoiceLines ?? []) line(l);
  if (data.customer) discount(data.customer.discount);
  return { prices: [...prices].sort(), coupons: [...coupons].sort() };
}
