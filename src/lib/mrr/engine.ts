// The MRR engine: one customer's billing data in, that customer's MRR history out (docs/m1-plan.md section 3,
// docs/build-plan.md 3.2). Pure and deterministic: the same input, in any order and with any repeats, gives the
// same rows, so a rebuild can never drift.
//
// Each subscription's MRR at a moment comes from, in order of precedence:
//   1. Zero after it ended (ended_at), during its trial, and while an invoice is unpaid more than 30 days after
//      its due date (from the start of day 31 until it's paid).
//   2. From the start of "now" (the later of its last invoice point and its last subscription update event):
//      the subscription as it is now, priced from its items, quantities, tiers and the discounts active at that
//      moment. Paused (status paused, or pause_collection from the end of the paid period until resumes_at),
//      incomplete and incomplete_expired count 0.
//   3. Before that, invoice history. A subscription's own recurring line (never a proration line) starts a
//      billing point: its amount after discounts counts from the line's period start to its end. A proration
//      line marks a change point at its period start: the items it names change to the new price and quantity,
//      priced as in 2. A void invoice counts 0 for its period. Draft invoices don't count.
//   Metered prices count the last invoiced amount from the end of the period it billed.
// One-time prices and invoice items never count. Interval to month: year 1/12, month 1/N for every N months,
// week 52/12, day 365/12. Line amounts are whole cents (Stripe's), discounts round per line half away from zero.
//
// The customer's MRR on a day is the sum of its subscriptions at the day's last second (UTC). It is an exact
// fraction of a cent until it changes; then it is converted at that day's rate and rounded once, half away from
// zero. A movement is the change between two rounded levels, so the movements always add up to the MRR and a
// churn always lands on exactly 0. Kinds: from 0 the first time, new; from 0 after that, reactivation; to 0,
// churn; up, expansion; down, contraction.

import { dayEnd, dayOf, dayStart, dayText, parseDay } from "./days.ts";
import { rateFinder, type Rate } from "./fx.ts";
import { absQ, add, cmp, decimal, div, eq, isZero, mul, q, roundHalfAway, sub as minus, toNumber, ZERO, type Q } from "./rational.ts";
import type {
  BuildResult,
  Cause,
  Coupon,
  CustomerDay,
  Discount,
  Invoice,
  InvoiceLine,
  Movement,
  MovementKind,
  MrrInput,
  Price,
  Recurring,
  Segment,
  Subscription,
} from "./types.ts";

/** Something the engine needs (a price) hasn't been loaded yet. The job tries again later. */
export class MissingDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingDataError";
  }
}

/** Days after the due date an invoice may stay unpaid before the subscription counts as churned (on day 31). */
export const UNPAID_CHURN_DAYS = 30;

/** Fields of a subscription update that can change MRR. An update with none of these doesn't move "now". */
export const MRR_FIELDS = new Set(["items", "quantity", "plan", "price", "discount", "discounts", "status", "pause_collection", "trial_end", "trial_start", "cancel_at", "ended_at"]);

/** How many months one billing period is worth, as the factor that turns a period amount into MRR. */
export function monthlyFactor(r: Recurring): Q {
  const n = BigInt(Math.max(1, Math.floor(r.intervalCount)));
  switch (r.interval) {
    case "month":
      return q(1n, n);
    case "year":
      return q(1n, 12n * n);
    case "week":
      return q(52n, 12n * n);
    case "day":
      return q(365n, 12n * n);
    default:
      throw new RangeError(`Unknown interval: ${String(r.interval)}`);
  }
}

const amountQ = (v: string | null) => (v == null || v === "" ? ZERO : decimal(v));

/** One period's price for `quantity` units, in exact cents, before discounts: per unit, tiers, packages. */
export function periodAmount(price: Price, quantity: number): Q {
  let units = BigInt(Math.max(0, Math.floor(quantity)));
  const t = price.transformQuantity;
  if (t && t.divideBy > 0) {
    const by = BigInt(Math.floor(t.divideBy));
    units = t.round === "up" ? (units + by - 1n) / by : units / by;
  }
  if (price.billingScheme !== "tiered") return mul(amountQ(price.unitAmount), q(units));
  const tiers = [...price.tiers].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  if (!tiers.length) throw new MissingDataError(`Price ${price.id} is tiered but has no tiers`);
  if (price.tiersMode === "volume") {
    const tier = tiers.find((x) => x.upTo == null || units <= BigInt(x.upTo)) ?? tiers[tiers.length - 1]!;
    return units === 0n ? ZERO : add(mul(amountQ(tier.unitAmount), q(units)), amountQ(tier.flatAmount));
  }
  // Graduated: each tier prices its own units, plus its flat fee when it has any.
  let total = ZERO;
  let done = 0n;
  for (const tier of tiers) {
    if (done >= units) break;
    const cap = tier.upTo == null ? units : BigInt(tier.upTo) < units ? BigInt(tier.upTo) : units;
    const inTier = cap - done;
    if (inTier <= 0n) continue;
    total = add(total, add(mul(amountQ(tier.unitAmount), q(inTier)), amountQ(tier.flatAmount)));
    done = cap;
  }
  return total;
}

const big = (n: number) => BigInt(Math.round(n));
const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One copy per id. Conflicting copies keep the one whose JSON sorts last, so input order never matters. */
export function uniqueById<T extends { id: string }>(xs: T[]): T[] {
  const best = new Map<string, { x: T; s: string }>();
  for (const x of xs) {
    const s = JSON.stringify(x);
    const had = best.get(x.id);
    if (!had || s > had.s) best.set(x.id, { x, s });
  }
  return [...best.values()].map((v) => v.x).sort((a, b) => byText(a.id, b.id));
}

type Ctx = {
  prices: Map<string, Price>;
  coupons: Map<string, Coupon>;
  discounts: Discount[];
  price(id: string | null, what: string): Price;
};

// rank orders breaks at the same moment by how well they explain a change: an unpaid window, then an invoice
// point, then "now", then dated subscription fields, and last a period simply ending.
type Break = { at: number; rank: number; cause: Cause };
type Item = { key: string; priceId: string; quantity: number; end: number; lineValue: Q | null };
type Snapshot = { at: number; kind: "billing" | "change"; void: boolean; items: Item[]; cause: Cause; periodEnd: number };
type Metered = { key: string; from: number; value: Q; cause: Cause };
type Window = { from: number; to: number | null; cause: Cause };

type Timeline = { sub: Subscription; valueAt: (t: number) => Q; breaks: Break[] };

/** Discounts on a subscription at moment t: its own, else the customer's. "Once" coupons only touch one invoice. */
function activeDiscounts(ctx: Ctx, subId: string, t: number): Coupon[] {
  const live = (d: Discount) => d.start <= t && (d.end == null || t < d.end);
  const coupon = (d: Discount) => ctx.coupons.get(d.couponId);
  const pick = (ds: Discount[]) => ds.filter(live).map(coupon).filter((c): c is Coupon => !!c && c.duration !== "once");
  const own = pick(ctx.discounts.filter((d) => d.scope === "subscription" && d.subscriptionId === subId));
  return own.length ? own : pick(ctx.discounts.filter((d) => d.scope === "customer"));
}

/** MRR of a set of licensed items at moment t, priced from their prices with the discounts active then. */
function priceItems(ctx: Ctx, sub: Subscription, items: { priceId: string; quantity: number }[], t: number): Q {
  const coupons = activeDiscounts(ctx, sub.id, t);
  let total = ZERO;
  let offBase = 0n;
  let offFactor: Q | null = null;
  const sorted = [...items].sort((a, b) => byText(a.priceId, b.priceId) || a.quantity - b.quantity);
  for (const item of sorted) {
    const price = ctx.price(item.priceId, `subscription ${sub.id}`);
    if (!price.recurring || price.recurring.usageType === "metered") continue;
    const cents = roundHalfAway(periodAmount(price, item.quantity));
    const applies = (c: Coupon) => !c.appliesTo || (price.productId != null && c.appliesTo.includes(price.productId));
    let off = 0n;
    for (const c of coupons) if (c.percentOff != null && applies(c)) off += roundHalfAway(mul(q(cents), div(decimal(c.percentOff), q(100n))));
    const net = maxBig(0n, cents - off);
    const factor = monthlyFactor(price.recurring);
    total = add(total, mul(q(net), factor));
    if (coupons.some((c) => c.amountOff != null && applies(c))) {
      offBase += net;
      offFactor ??= factor;
    }
  }
  // Amount-off coupons come off each invoice: off the period total of the items they apply to, never below 0.
  let amountOff = 0n;
  for (const c of coupons) if (c.amountOff != null && (c.currency == null || c.currency === sub.currency)) amountOff += big(c.amountOff);
  if (amountOff > 0n && offFactor) total = minus(total, mul(q(minBig(amountOff, offBase)), offFactor));
  return total;
}

function subTimeline(ctx: Ctx, s: Subscription, lines: InvoiceLine[], invoices: Invoice[], limit: number): Timeline {
  const invoiceOf = new Map<string, Invoice>();
  for (const inv of invoices) for (const l of inv.lines) invoiceOf.set(l.id, inv);
  const cause = (inv: Invoice): Cause => ({ type: "invoice", id: inv.id });
  const subCause: Cause = { type: "subscription", id: s.id };
  const breaks: Break[] = [];

  // Billing points: per invoice and period start, the subscription's own recurring licensed lines.
  type Group = { inv: Invoice; at: number; lines: InvoiceLine[] };
  const groups = new Map<string, Group>();
  const metered: Metered[] = [];
  const changes = new Map<number, { inv: Invoice; plus: Map<string, InvoiceLine>; minus: Set<string> }>();
  const keyOf = (l: InvoiceLine) => l.subscriptionItemId ?? `price:${l.priceId ?? l.id}`;

  for (const l of lines) {
    const inv = invoiceOf.get(l.id)!;
    if (inv.status === "draft") continue;
    if (l.proration) {
      if (!l.subscriptionItemId && !l.priceId) continue;
      const price = l.priceId ? ctx.price(l.priceId, `invoice ${inv.id}`) : null;
      if (price && (!price.recurring || price.recurring.usageType === "metered")) continue;
      const c = changes.get(l.periodStart) ?? { inv, plus: new Map(), minus: new Set() };
      // The same change can sit on more than one invoice; the latest one names it.
      if (inv.created > c.inv.created || (inv.created === c.inv.created && inv.id > c.inv.id)) c.inv = inv;
      if (l.amount < 0) c.minus.add(keyOf(l));
      else {
        const had = c.plus.get(keyOf(l));
        if (!had || l.id > had.id) c.plus.set(keyOf(l), l);
      }
      changes.set(l.periodStart, c);
      continue;
    }
    if (l.kind !== "subscription") continue;
    const price = ctx.price(l.priceId, `invoice ${inv.id}`);
    if (!price.recurring) continue;
    if (price.recurring.usageType === "metered") {
      metered.push({ key: keyOf(l), from: l.periodEnd, value: mul(q(maxBig(0n, big(l.amount) - big(l.discount))), monthlyFactor(price.recurring)), cause: cause(inv) });
      continue;
    }
    const gk = `${inv.id}|${l.periodStart}`;
    const g = groups.get(gk) ?? { inv, at: l.periodStart, lines: [] };
    g.lines.push(l);
    groups.set(gk, g);
  }

  // One billing point per period start: a non-void invoice over a void one, then the latest.
  const rank = (g: Group) => [g.inv.status === "void" ? 0 : 1, g.inv.created, g.inv.id] as const;
  const better = (a: Group, b: Group) => {
    const x = rank(a);
    const y = rank(b);
    return x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2];
  };
  const byStart = new Map<number, Group>();
  for (const g of groups.values()) {
    const had = byStart.get(g.at);
    if (!had || better(g, had)) byStart.set(g.at, g);
  }

  type Ev = { at: number; order: number; id: string; apply: (prev: Snapshot | null) => Snapshot };
  const events: Ev[] = [];
  for (const g of byStart.values()) {
    events.push({
      at: g.at,
      order: 1,
      id: g.inv.id,
      apply: () => {
        const items: Item[] = [];
        const seen = new Set<string>();
        for (const l of [...g.lines].sort((a, b) => byText(a.id, b.id))) {
          let key = keyOf(l);
          if (seen.has(key)) key = `${key}#${l.id}`;
          seen.add(key);
          const price = ctx.price(l.priceId, `invoice ${g.inv.id}`);
          items.push({
            key,
            priceId: price.id,
            quantity: l.quantity,
            end: l.periodEnd,
            lineValue: mul(q(maxBig(0n, big(l.amount) - big(l.discount))), monthlyFactor(price.recurring!)),
          });
        }
        return { at: g.at, kind: "billing", void: g.inv.status === "void", items, cause: cause(g.inv), periodEnd: Math.max(g.at, ...items.map((i) => i.end)) };
      },
    });
  }
  for (const [at, c] of changes) {
    events.push({
      at,
      order: 0,
      id: c.inv.id,
      apply: (prev) => {
        const items = new Map<string, Item>((prev?.items ?? []).map((i) => [i.key, i]));
        // Lines that name only a price (2025 API prorations have no subscription item) mean the item with that price.
        const resolve = (k: string) => {
          if (!k.startsWith("price:") || items.has(k)) return k;
          const hit = [...items.values()].filter((i) => `price:${i.priceId}` === k).sort((a, b) => byText(a.key, b.key))[0];
          return hit ? hit.key : k;
        };
        const plus = new Map([...c.plus].map(([k, l]) => [resolve(k), l] as const));
        for (const k of [...c.minus].map(resolve)) if (!plus.has(k)) items.delete(k);
        for (const [k, l] of plus) items.set(k, { key: k, priceId: ctx.price(l.priceId ?? items.get(k)?.priceId ?? null, `invoice ${c.inv.id}`).id, quantity: l.quantity, end: l.periodEnd, lineValue: null });
        return { at, kind: "change", void: prev?.void ?? false, items: [...items.values()].sort((a, b) => byText(a.key, b.key)), cause: cause(c.inv), periodEnd: prev?.periodEnd ?? at };
      },
    });
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order || byText(a.id, b.id));
  const snaps: Snapshot[] = [];
  let lastBilling: Snapshot | null = null;
  for (const e of events) {
    if (e.at > limit) break;
    const snap = e.apply(snaps[snaps.length - 1] ?? null);
    snaps.push(snap);
    if (snap.kind === "billing") lastBilling = snap;
    breaks.push({ at: snap.at, rank: 1, cause: snap.cause });
    for (const i of snap.items) breaks.push({ at: i.end, rank: 4, cause: snap.cause });
  }
  metered.sort((a, b) => a.from - b.from || byText(a.key, b.key) || byText(a.cause.id, b.cause.id));
  for (const m of metered) breaks.push({ at: m.from, rank: 1, cause: m.cause });

  // "Now": the subscription as it is, from the later of its last invoice point and its last MRR-changing update.
  const lastPoint = snaps.length ? snaps[snaps.length - 1]!.at : null;
  let csStart = lastPoint ?? s.startDate ?? s.created;
  let csCause: Cause = subCause;
  if (lastPoint != null) {
    const updates = [...s.updates].sort((a, b) => a.at - b.at || byText(a.eventId, b.eventId));
    for (const u of updates) {
      if (u.at <= csStart || u.at > limit) continue;
      if (u.fields && !u.fields.some((f) => MRR_FIELDS.has(f))) continue;
      csStart = u.at;
      csCause = { type: "event", id: u.eventId };
    }
  }
  breaks.push({ at: csStart, rank: 2, cause: csCause });

  const ended = s.endedAt ?? (s.status === "canceled" || s.status === "incomplete_expired" ? (s.canceledAt ?? csStart) : null);
  if (ended != null) breaks.push({ at: ended, rank: 3, cause: subCause });
  const trialFrom = s.trialStart ?? s.startDate ?? s.created;
  if (s.trialEnd != null) breaks.push({ at: trialFrom, rank: 3, cause: subCause }, { at: s.trialEnd, rank: 3, cause: subCause });
  const pause = s.pauseCollection;
  const pauseFrom = pause ? Math.max(csStart, lastBilling?.periodEnd ?? csStart) : null;
  if (pause && pauseFrom != null) {
    breaks.push({ at: pauseFrom, rank: 3, cause: subCause });
    if (pause.resumesAt != null) breaks.push({ at: pause.resumesAt, rank: 3, cause: subCause });
  }
  for (const d of ctx.discounts) {
    if (d.scope === "invoice" || (d.scope === "subscription" && d.subscriptionId !== s.id)) continue;
    breaks.push({ at: d.start, rank: 3, cause: subCause });
    if (d.end != null) breaks.push({ at: d.end, rank: 3, cause: subCause });
  }

  // Unpaid more than 30 days after the due date: 0 from the start of day 31 until paid.
  const windows: Window[] = [];
  for (const inv of invoices) {
    if (inv.status === "draft" || inv.status === "void" || inv.amountDue <= 0) continue;
    const from = dayStart(dayOf(inv.dueAt) + UNPAID_CHURN_DAYS + 1);
    if (inv.status === "paid" && (inv.paidAt == null || inv.paidAt < from)) continue;
    const to = inv.status === "paid" ? inv.paidAt : null;
    windows.push({ from, to, cause: cause(inv) });
    breaks.push({ at: from, rank: 0, cause: cause(inv) });
    if (to != null) breaks.push({ at: to, rank: 0, cause: cause(inv) });
  }

  const nowKeys = new Set(s.items.flatMap((i) => [i.id, `price:${i.priceId}`]));
  const meteredAt = (t: number, onlyNow: boolean): Q => {
    const last = new Map<string, Q>();
    for (const m of metered) if (m.from <= t && (!onlyNow || nowKeys.has(m.key))) last.set(m.key, m.value);
    return [...last.values()].reduce(add, ZERO);
  };
  const current = (t: number): Q => {
    if (s.status === "paused" || s.status === "incomplete" || s.status === "incomplete_expired") return ZERO;
    if (pause && pauseFrom != null && t >= pauseFrom && (pause.resumesAt == null || t < pause.resumesAt)) return ZERO;
    return add(priceItems(ctx, s, s.items, t), meteredAt(t, true));
  };
  const historic = (t: number): Q => {
    let snap: Snapshot | null = null;
    for (const x of snaps) {
      if (x.at > t) break;
      snap = x;
    }
    let v = ZERO;
    if (snap && !snap.void) {
      const live = snap.items.filter((i) => t < i.end);
      v = snap.kind === "billing" ? live.reduce((acc, i) => add(acc, i.lineValue!), ZERO) : priceItems(ctx, s, live, t);
    }
    return add(v, meteredAt(t, false));
  };
  const valueAt = (t: number): Q => {
    if (ended != null && t >= ended) return ZERO;
    if (s.trialEnd != null && t >= trialFrom && t < s.trialEnd) return ZERO;
    for (const w of windows) if (t >= w.from && (w.to == null || t < w.to)) return ZERO;
    return t >= csStart ? current(t) : historic(t);
  };

  return { sub: s, valueAt, breaks: breaks.filter((b) => b.at <= limit).sort((a, b) => a.at - b.at || a.rank - b.rank || byText(a.cause.id, b.cause.id)) };
}

/** The moment and cause of a subscription's change on a day: the latest moment that day where its value moved,
 *  and the best-ranked break at that moment. */
function changeOn(tl: Timeline, day: number): Break {
  const from = dayStart(day);
  const to = dayEnd(day);
  let found: Break | null = null;
  for (const b of tl.breaks) {
    if (b.at < from || b.at > to) continue;
    if ((!found || b.at > found.at) && !eq(tl.valueAt(b.at - 1), tl.valueAt(b.at))) found = b;
  }
  return found ?? { at: from, rank: 9, cause: { type: "subscription", id: tl.sub.id } };
}

function classify(before: bigint, after: bigint, everPositive: boolean): MovementKind {
  if (before === 0n) return everPositive ? "reactivation" : "new";
  if (after === 0n) return "churn";
  return after > before ? "expansion" : "contraction";
}

function context(input: MrrInput): Ctx {
  const prices = new Map(uniqueById(input.prices).map((p) => [p.id, p]));
  const coupons = new Map(uniqueById(input.coupons).map((c) => [c.id, c]));
  return {
    prices,
    coupons,
    discounts: uniqueById(input.discounts),
    price(id, what) {
      const p = id ? prices.get(id) : undefined;
      if (!p) throw new MissingDataError(`Price ${id ?? "(none)"} for ${what} isn't loaded`);
      return p;
    },
  };
}

/** One customer's MRR segments, daily levels and movements, from its subscriptions and invoices. */
export function buildCustomer(input: MrrInput): BuildResult {
  const ws = input.currency.toLowerCase();
  const limit = dayEnd(parseDay(input.asOf));
  const ctx = context(input);
  const subs = uniqueById(input.subscriptions);
  const invoices = uniqueById(input.invoices).map((inv) => ({ ...inv, lines: uniqueById(inv.lines) }));

  const timelines = subs.map((s) => {
    const mine = invoices.filter((inv) => inv.subscriptionId === s.id || inv.lines.some((l) => l.subscriptionId === s.id));
    const lines = mine.flatMap((inv) => inv.lines.filter((l) => (l.subscriptionId ?? inv.subscriptionId) === s.id));
    // Unpaid invoices belong to the subscription they bill.
    const owned = mine.filter((inv) => (inv.subscriptionId ?? inv.lines.find((l) => l.subscriptionId)?.subscriptionId) === s.id);
    return subTimeline(ctx, s, lines, owned, limit);
  });

  const days = [...new Set(timelines.flatMap((tl) => tl.breaks.map((b) => dayOf(b.at))))].sort((a, b) => a - b);
  const rates = rateFinder(input.fx, ws);
  const currencies = [...new Set(subs.map((s) => s.currency.toLowerCase()))].sort();
  const native = currencies.length === 1 ? currencies[0]! : ws;

  const movements: Movement[] = [];
  const segments: Segment[] = [];
  const customerDays: CustomerDay[] = [];
  const openSeg: (Segment | null)[] = subs.map(() => null);
  let prevVals: Q[] = subs.map(() => ZERO);
  let prevWs = 0n;
  let prevNative = 0n;
  let prevRate: Rate | null = null;
  let everPositive = false;
  let openDay: CustomerDay | null = null;

  for (const day of days) {
    const t = dayEnd(day);
    if (t > limit) break;
    const vals = timelines.map((tl) => tl.valueAt(t));
    if (vals.every((v, i) => eq(v, prevVals[i]!))) continue;

    // Each subscription's own segments, in its own currency.
    vals.forEach((v, i) => {
      const cents = toNumber(roundHalfAway(v));
      const open = openSeg[i];
      if (open ? open.mrr === cents : cents === 0) return;
      if (open) open.to = dayText(day);
      const seg: Segment = { subscriptionId: subs[i]!.id, from: dayText(day), to: null, mrr: cents, currency: subs[i]!.currency.toLowerCase() };
      segments.push(seg);
      openSeg[i] = seg;
    });

    // The customer's level: each currency's exact total at that day's rate, then one rounding.
    let wsExact = ZERO;
    let nativeExact = ZERO;
    for (const cur of currencies) {
      const total = vals.reduce((acc, v, i) => (subs[i]!.currency.toLowerCase() === cur ? add(acc, v) : acc), ZERO);
      if (cur === native) nativeExact = total;
      if (!isZero(total)) wsExact = add(wsExact, mul(total, rates(cur, day).rate));
    }
    if (native === ws && currencies.length !== 1) nativeExact = wsExact;
    const level = roundHalfAway(wsExact);
    const nativeLevel = roundHalfAway(nativeExact);
    let rate: Rate;
    try {
      rate = rates(native, day);
    } catch (e) {
      // A churn needs no rate to be exact; it keeps the last one it had.
      if (level !== 0n || !prevRate) throw e;
      rate = prevRate;
    }

    if (level !== prevWs) {
      // The subscription that moved most is the one behind the movement.
      let pick = -1;
      let biggest = ZERO;
      vals.forEach((v, i) => {
        const delta = absQ(minus(v, prevVals[i]!));
        if (!isZero(delta) && (pick < 0 || cmp(delta, biggest) > 0)) {
          pick = i;
          biggest = delta;
        }
      });
      const tl = timelines[Math.max(0, pick)]!;
      const change = pick >= 0 ? changeOn(tl, day) : { at: dayStart(day), rank: 9, cause: { type: "subscription" as const, id: tl.sub.id } };
      movements.push({
        day: dayText(day),
        at: change.at,
        kind: classify(prevWs, level, everPositive),
        amount: toNumber(level - prevWs),
        mrrBefore: toNumber(prevWs),
        mrrAfter: toNumber(level),
        currency: ws,
        originalAmount: toNumber(nativeLevel - prevNative),
        originalCurrency: native,
        rate: rate.text,
        subscriptionId: pick >= 0 ? tl.sub.id : null,
        cause: change.cause,
      });
    }
    if (level !== prevWs || nativeLevel !== prevNative) {
      if (openDay) openDay.to = dayText(day);
      openDay = { from: dayText(day), to: null, mrr: toNumber(level), mrrNative: toNumber(nativeLevel), nativeCurrency: native, rate: rate.text };
      customerDays.push(openDay);
    }
    if (level > 0n) everPositive = true;
    prevVals = vals;
    prevWs = level;
    prevNative = nativeLevel;
    prevRate = rate;
  }

  return { customerId: input.customerId, currency: ws, mrr: toNumber(prevWs), segments, days: customerDays, movements };
}

