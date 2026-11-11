// The MRR engine (src/lib/mrr) against hand-worked Stripe histories (tests/fixtures/stripe/*.json, docs/m1-plan.md
// section 6). Every movement must match to the cent. Each fixture also runs 50 times with its objects shuffled and
// repeated, the way webhooks and backfill pages arrive, and must give exactly the same rows.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildCustomer,
  feedItems,
  fromStripe,
  MissingDataError,
  MissingRateError,
  monthlyFactor,
  periodAmount,
  referencedIds,
  type MrrInput,
  type Price,
  type StripeData,
} from "../src/lib/mrr/index.ts";
import { decimal, q, roundHalfAway, toDecimalText } from "../src/lib/mrr/rational.ts";

const DIR = join(import.meta.dirname, "fixtures", "stripe");

type Fixture = {
  name: string;
  notes: string[];
  currency: string;
  asOf: string;
  stripe: StripeData;
  fx: { day: string; base: string; quote: string; rate: string }[];
  expected: {
    mrr: number;
    movements: { day: string; kind: string; amount: number; originalAmount?: number; originalCurrency?: string; rate?: string; cause?: { type: string; id: string } }[];
    feed: { kind: string; day: string; amount: number }[];
  };
};

const fixtures: Fixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture);

const run = (fx: Fixture, stripe: StripeData = fx.stripe) => {
  const input = fromStripe(stripe, { currency: fx.currency, asOf: fx.asOf, fx: fx.fx });
  const result = buildCustomer(input);
  return { input, result, feed: feedItems(input, result) };
};

test("every case in docs/m1-plan.md section 6 has a fixture", () => {
  const names = fixtures.map((f) => f.name).sort();
  assert.deepEqual(names, [
    "cancel_at_period_end",
    "coupon_100_then_paid",
    "coupon_50_three_months",
    "euro_customer_usd_workspace",
    "monthly_to_annual_proration",
    "pause_and_resume",
    "refund_after_cancel",
    "seat_quantity_change",
    "tiered_price",
    "trial_to_cancel",
    "trial_to_paid",
    "two_subscriptions",
    "unpaid_31_days_then_paid",
  ]);
  for (const f of fixtures) assert.ok(f.notes.length > 0, `${f.name} explains its answer`);
});

for (const fx of fixtures) {
  test(`fixture ${fx.name}: movements to the cent`, () => {
    const { result, feed } = run(fx);
    const got = result.movements.map((m, i) => {
      const want = fx.expected.movements[i];
      const row: Record<string, unknown> = { day: m.day, kind: m.kind, amount: m.amount };
      if (want?.originalAmount !== undefined) row.originalAmount = m.originalAmount;
      if (want?.originalCurrency !== undefined) row.originalCurrency = m.originalCurrency;
      if (want?.rate !== undefined) row.rate = m.rate;
      if (want?.cause !== undefined) row.cause = m.cause;
      return row;
    });
    assert.deepEqual(got, fx.expected.movements);
    assert.equal(result.mrr, fx.expected.mrr);
    assert.deepEqual(
      feed.map((f) => ({ kind: f.kind, day: f.day, amount: f.amount })),
      fx.expected.feed,
    );
  });

  test(`fixture ${fx.name}: the same rows 50 times with objects shuffled and repeated`, () => {
    const base = run(fx);
    const rand = seeded(hash(fx.name));
    for (let i = 0; i < 50; i++) {
      const again = run(fx, scramble(fx.stripe, rand));
      assert.deepEqual(again.result, base.result, `run ${i + 1} differs`);
      assert.deepEqual(again.feed, base.feed, `run ${i + 1} feed differs`);
    }
  });
}

test("movements add up to the MRR, churn lands on 0, and each kind has its sign", () => {
  for (const fx of fixtures) {
    const { result } = run(fx);
    let level = 0;
    let ever = false;
    for (const m of result.movements) {
      assert.equal(m.mrrBefore, level, `${fx.name} ${m.day}: before`);
      level += m.amount;
      assert.equal(m.mrrAfter, level, `${fx.name} ${m.day}: after`);
      assert.ok(Number.isInteger(m.amount) && m.amount !== 0);
      if (m.kind === "churn") assert.equal(m.mrrAfter, 0);
      if (m.kind === "new") assert.ok(!ever && m.mrrBefore === 0);
      if (m.kind === "reactivation") assert.ok(ever && m.mrrBefore === 0);
      if (["new", "expansion", "reactivation"].includes(m.kind)) assert.ok(m.amount > 0);
      else assert.ok(m.amount < 0);
      if (m.mrrAfter > 0) ever = true;
    }
    assert.equal(level, result.mrr, fx.name);
    // The customer's days agree with the movements.
    const last = result.days.at(-1);
    assert.equal(last?.mrr ?? 0, result.mrr, `${fx.name}: days`);
    assert.equal(last?.to ?? null, null);
  }
});

test("segments per subscription follow the invoices and the subscription", () => {
  const two = fixtures.find((f) => f.name === "two_subscriptions")!;
  const { result } = run(two);
  assert.deepEqual(result.segments, [
    { subscriptionId: "sub_two_a", from: "2026-01-01", to: null, mrr: 3000, currency: "usd" },
    { subscriptionId: "sub_two_b", from: "2026-02-15", to: "2026-04-15", mrr: 2000, currency: "usd" },
    { subscriptionId: "sub_two_b", from: "2026-04-15", to: null, mrr: 0, currency: "usd" },
  ]);
  assert.deepEqual(result.days, [
    { from: "2026-01-01", to: "2026-02-15", mrr: 3000, mrrNative: 3000, nativeCurrency: "usd", rate: "1" },
    { from: "2026-02-15", to: "2026-04-15", mrr: 5000, mrrNative: 5000, nativeCurrency: "usd", rate: "1" },
    { from: "2026-04-15", to: null, mrr: 3000, mrrNative: 3000, nativeCurrency: "usd", rate: "1" },
  ]);
});

test("nothing after asOf counts", () => {
  const unpaid = fixtures.find((f) => f.name === "unpaid_31_days_then_paid")!;
  const before = run({ ...unpaid, asOf: "2026-04-05" }).result;
  assert.deepEqual(
    before.movements.map((m) => [m.day, m.kind]),
    [
      ["2026-01-01", "new"],
      ["2026-04-01", "churn"],
    ],
  );
  assert.equal(before.mrr, 0);
});

// ---------- Rules, one at a time ----------

const T = (s: string) => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : `${s}Z`) / 1000;

function priceOf(id: string, amount: number, interval: "day" | "week" | "month" | "year", intervalCount = 1, extra: Partial<Price> = {}): Price {
  return { id, currency: "usd", productId: "prod_x", unitAmount: String(amount), billingScheme: "per_unit", tiersMode: null, tiers: [], recurring: { interval, intervalCount, usageType: "licensed" }, transformQuantity: null, ...extra };
}

/** One subscription priced from its items as it is now (no invoices), active since Jan 1 2026. */
function now(prices: Price[], items: { priceId: string; quantity?: number }[], extra: Partial<MrrInput> = {}): MrrInput {
  return {
    customerId: "cus_x",
    currency: "usd",
    asOf: "2026-02-01",
    subscriptions: [
      { id: "sub_x", currency: "usd", status: "active", created: T("2026-01-01"), startDate: T("2026-01-01"), trialStart: null, trialEnd: null, endedAt: null, canceledAt: null, pauseCollection: null, items: items.map((it, i) => ({ id: `si_${i}`, priceId: it.priceId, quantity: it.quantity ?? 1 })), updates: [] },
    ],
    invoices: [],
    prices,
    coupons: [],
    discounts: [],
    charges: [],
    refunds: [],
    fx: [],
    ...extra,
  };
}
const mrrOf = (input: MrrInput) => buildCustomer(input).mrr;

test("intervals: year 1/12, quarter 1/3, every N months 1/N, week 52/12, day 365/12, rounded once half away from zero", () => {
  assert.equal(mrrOf(now([priceOf("p", 30000, "year")], [{ priceId: "p" }])), 2500);
  assert.equal(mrrOf(now([priceOf("p", 9000, "month", 3)], [{ priceId: "p" }])), 3000);
  assert.equal(mrrOf(now([priceOf("p", 6000, "month", 6)], [{ priceId: "p" }])), 1000);
  assert.equal(mrrOf(now([priceOf("p", 1000, "week")], [{ priceId: "p" }])), 4333); // 4333.33
  assert.equal(mrrOf(now([priceOf("p", 2000, "week", 2)], [{ priceId: "p" }])), 4333);
  assert.equal(mrrOf(now([priceOf("p", 100, "day")], [{ priceId: "p" }])), 3042); // 3041.67
  assert.equal(mrrOf(now([priceOf("p", 150, "year")], [{ priceId: "p" }])), 13); // 12.5 rounds up
  assert.equal(mrrOf(now([priceOf("p", 9999, "year", 2)], [{ priceId: "p" }])), 417); // 416.625
  // Two annual items: summed exactly first (833.33 + 833.33 = 1666.67), rounded once.
  assert.equal(mrrOf(now([priceOf("a", 10000, "year"), priceOf("b", 10000, "year")], [{ priceId: "a" }, { priceId: "b" }])), 1667);
  assert.deepEqual(monthlyFactor({ interval: "week", intervalCount: 1, usageType: "licensed" }), q(52, 12));
  assert.equal(roundHalfAway(q(-5, 2)), -3n);
  assert.equal(roundHalfAway(q(5, 2)), 3n);
  assert.equal(roundHalfAway(q(-12, 5)), -2n);
  assert.equal(toDecimalText(decimal("1.08700")), "1.087");
});

test("quantity multiplies, one-time prices count 0, per-package and volume tiers", () => {
  assert.equal(mrrOf(now([priceOf("p", 1250, "month")], [{ priceId: "p", quantity: 7 }])), 8750);
  assert.equal(mrrOf(now([{ ...priceOf("p", 5000, "month"), recurring: null }], [{ priceId: "p" }])), 0);
  const pack = priceOf("p", 2500, "month", 1, { transformQuantity: { divideBy: 10, round: "up" } });
  assert.equal(mrrOf(now([pack], [{ priceId: "p", quantity: 21 }])), 7500); // 3 packs
  const vol = priceOf("v", 0, "month", 1, {
    unitAmount: null,
    billingScheme: "tiered",
    tiersMode: "volume",
    tiers: [
      { upTo: 10, unitAmount: "500", flatAmount: null },
      { upTo: null, unitAmount: "400", flatAmount: "1000" },
    ],
  });
  assert.equal(mrrOf(now([vol], [{ priceId: "v", quantity: 10 }])), 5000);
  assert.equal(mrrOf(now([vol], [{ priceId: "v", quantity: 11 }])), 5400); // every unit at the 11+ price, plus its flat fee
  // Fractional unit amounts are whole cents per line, as Stripe bills them.
  assert.deepEqual(periodAmount(priceOf("d", 0, "month", 1, { unitAmount: "0.125" }), 3), q(3, 8));
  assert.equal(mrrOf(now([priceOf("d", 0, "month", 1, { unitAmount: "12.345" })], [{ priceId: "d", quantity: 100 }])), 1235); // 1234.5 → 1235
});

test("discounts: percent off lowers MRR, 100% and amount off down to 0, once-only coupons don't count", () => {
  const p = priceOf("p", 3000, "month");
  const disc = (couponId: string, start = T("2026-01-01"), end: number | null = null) => ({ id: `di_${couponId}`, couponId, scope: "subscription" as const, subscriptionId: "sub_x", start, end });
  const coupons = [
    { id: "pct25", percentOff: "25", amountOff: null, currency: null, duration: "forever" as const, appliesTo: null },
    { id: "full", percentOff: "100", amountOff: null, currency: null, duration: "forever" as const, appliesTo: null },
    { id: "off10", percentOff: null, amountOff: 1000, currency: "usd", duration: "repeating" as const, appliesTo: null },
    { id: "off99", percentOff: null, amountOff: 9900, currency: "usd", duration: "forever" as const, appliesTo: null },
    { id: "once", percentOff: "50", amountOff: null, currency: null, duration: "once" as const, appliesTo: null },
    { id: "other", percentOff: "50", amountOff: null, currency: null, duration: "forever" as const, appliesTo: ["prod_other"] },
  ];
  const with_ = (id: string, extra: Partial<MrrInput> = {}) => mrrOf(now([p], [{ priceId: "p" }], { coupons, discounts: [disc(id)], ...extra }));
  assert.equal(with_("pct25"), 2250);
  assert.equal(with_("full"), 0);
  assert.equal(with_("off10"), 2000);
  assert.equal(with_("off99"), 0);
  assert.equal(with_("once"), 3000);
  assert.equal(with_("other"), 3000);
  // A discount that ended no longer counts; a customer discount counts when the subscription has none.
  assert.equal(mrrOf(now([p], [{ priceId: "p" }], { coupons, discounts: [disc("pct25", T("2026-01-01"), T("2026-01-15"))] })), 3000);
  assert.equal(mrrOf(now([p], [{ priceId: "p" }], { coupons, discounts: [{ ...disc("pct25"), scope: "customer", subscriptionId: null }] })), 2250);
  // Its end is a movement on the day it ends.
  const r = buildCustomer(now([p], [{ priceId: "p" }], { coupons, discounts: [disc("pct25", T("2026-01-01"), T("2026-01-15T06:00:00"))] }));
  assert.deepEqual(
    r.movements.map((m) => [m.day, m.kind, m.amount]),
    [
      ["2026-01-01", "new", 2250],
      ["2026-01-15", "expansion", 750],
    ],
  );
});

test("statuses: trialing, paused, incomplete and pause_collection count 0", () => {
  const p = priceOf("p", 3000, "month");
  const base = now([p], [{ priceId: "p" }]);
  const withSub = (s: Partial<MrrInput["subscriptions"][number]>) => mrrOf({ ...base, subscriptions: [{ ...base.subscriptions[0]!, ...s }] });
  assert.equal(withSub({}), 3000);
  assert.equal(withSub({ status: "trialing", trialStart: T("2026-01-01"), trialEnd: T("2026-03-01") }), 0);
  assert.equal(withSub({ status: "paused" }), 0);
  assert.equal(withSub({ status: "incomplete" }), 0);
  assert.equal(withSub({ pauseCollection: { behavior: "keep_as_draft", resumesAt: null } }), 0);
  assert.equal(withSub({ pauseCollection: { behavior: "void", resumesAt: T("2026-01-20") } }), 3000);
  assert.equal(withSub({ status: "past_due" }), 3000);
  assert.equal(withSub({ status: "canceled", endedAt: T("2026-01-31T23:00:00") }), 0);
});

test("metered prices count the last invoiced amount, from the end of the period it billed", () => {
  const usage: Price = { ...priceOf("m", 2, "month"), recurring: { interval: "month", intervalCount: 1, usageType: "metered" } };
  const input = now([usage], [{ priceId: "m" }], {
    asOf: "2026-03-10",
    invoices: [1, 2].map((n) => ({
      id: `in_m${n}`,
      subscriptionId: "sub_x",
      status: "paid" as const,
      currency: "usd",
      created: T(n === 1 ? "2026-02-01" : "2026-03-01"),
      dueAt: T(n === 1 ? "2026-02-01" : "2026-03-01"),
      paidAt: T(n === 1 ? "2026-02-01" : "2026-03-01"),
      amountDue: n * 4000,
      lines: [{ id: `il_m${n}`, kind: "subscription" as const, subscriptionId: "sub_x", subscriptionItemId: "si_0", priceId: "m", quantity: 2000 * n, amount: 4000 * n, discount: 0, proration: false, periodStart: T(n === 1 ? "2026-01-01" : "2026-02-01"), periodEnd: T(n === 1 ? "2026-02-01" : "2026-03-01") }],
    })),
  });
  assert.deepEqual(
    buildCustomer(input).movements.map((m) => [m.day, m.kind, m.amount]),
    [
      ["2026-02-01", "new", 4000],
      ["2026-03-01", "expansion", 4000],
    ],
  );
});

test("a missing rate or price is an error, never a guess", () => {
  const eur = { ...priceOf("e", 4900, "month"), currency: "eur" };
  const input = now([eur], [{ priceId: "e" }]);
  input.subscriptions[0]!.currency = "eur";
  assert.throws(() => buildCustomer(input), (e: unknown) => e instanceof MissingRateError && e.from === "eur" && e.to === "usd" && e.day === "2026-01-01");
  // A rate older than a week doesn't count; a week-old one does; a cross rate through the euro works.
  assert.throws(() => buildCustomer({ ...input, fx: [{ day: "2025-12-24", base: "eur", quote: "usd", rate: "1.08" }] }), MissingRateError);
  assert.equal(buildCustomer({ ...input, fx: [{ day: "2025-12-25", base: "eur", quote: "usd", rate: "1.08" }] }).mrr, 5292);
  const gbp = { ...priceOf("g", 1000, "month"), currency: "gbp" };
  const viaEur = now([gbp], [{ priceId: "g" }], {
    fx: [
      { day: "2026-01-01", base: "eur", quote: "usd", rate: "1.10" },
      { day: "2026-01-01", base: "eur", quote: "gbp", rate: "0.88" },
    ],
  });
  viaEur.subscriptions[0]!.currency = "gbp";
  const m = buildCustomer(viaEur).movements[0]!;
  assert.equal(m.amount, 1250); // 1000 x 1.10 / 0.88
  assert.equal(m.rate, "1.25");
  assert.throws(() => buildCustomer(now([], [{ priceId: "nope" }])), MissingDataError);
});

test("API versions from 2025 map the same as older ones", () => {
  const fx = fixtures.find((f) => f.name === "seat_quantity_change")!;
  const modern = structuredClone(fx.stripe) as StripeData;
  for (const inv of modern.invoices ?? []) {
    inv.parent = { type: "subscription_details", subscription_details: { subscription: inv.subscription } };
    delete inv.subscription;
    for (const l of (inv.lines as { data: Record<string, unknown>[] }).data) {
      const price = (l.price as { id: string }).id;
      l.pricing = { type: "price_details", price_details: { price, product: "prod_seats" }, unit_amount_decimal: "1000" };
      l.parent = {
        type: l.type === "subscription" ? "subscription_item_details" : "invoice_item_details",
        ...(l.type === "subscription"
          ? { subscription_item_details: { subscription: l.subscription, subscription_item: l.subscription_item, proration: l.proration, invoice_item: null } }
          : { invoice_item_details: { subscription: l.subscription, proration: l.proration, invoice_item: "ii_x" } }),
      };
      for (const k of ["price", "type", "subscription", "proration", "plan"]) delete l[k];
      // Older lines name the item at the top; 2025 prorations name it only through the price.
      if ((l.parent as { type: string }).type === "invoice_item_details") delete l.subscription_item;
    }
  }
  const a = run(fx).result.movements.map((m) => [m.day, m.kind, m.amount]);
  const b = run(fx, modern).result.movements.map((m) => [m.day, m.kind, m.amount]);
  assert.deepEqual(b, a);
});

test("referencedIds names every price and coupon a loader needs", () => {
  const fx = fixtures.find((f) => f.name === "coupon_50_three_months")!;
  assert.deepEqual(referencedIds(fx.stripe), { prices: ["price_pro_monthly"], coupons: ["co_half50"] });
});

// ---------- Shuffling ----------

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleRepeat<T>(xs: T[] | undefined, rand: () => number): T[] {
  const out = [...(xs ?? [])];
  for (const x of xs ?? []) if (rand() < 0.5) out.push(structuredClone(x));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
/** The same Stripe data as it might arrive: any order, some objects twice, some invoice lines stored on their own. */
function scramble(data: StripeData, rand: () => number): StripeData {
  const d = structuredClone(data);
  const invoiceLines: { invoiceId: string; line: Record<string, unknown> }[] = [];
  for (const inv of d.invoices ?? []) {
    const lines = inv.lines as { data: Record<string, unknown>[] };
    lines.data = shuffleRepeat(lines.data, rand).filter((l) => {
      if (rand() < 0.3) {
        invoiceLines.push({ invoiceId: inv.id as string, line: l });
        return false;
      }
      return true;
    });
  }
  return {
    customer: d.customer,
    subscriptions: shuffleRepeat(d.subscriptions, rand),
    invoices: shuffleRepeat(d.invoices, rand),
    invoiceLines: shuffleRepeat(invoiceLines, rand),
    prices: shuffleRepeat(d.prices, rand),
    coupons: shuffleRepeat(d.coupons, rand),
    charges: shuffleRepeat(d.charges, rand),
    refunds: shuffleRepeat(d.refunds, rand),
    events: shuffleRepeat(d.events, rand),
  };
}
