// The pure parts behind the M1 screens (docs/m1-plan.md section 5): date ranges and intervals, axis ticks and chart
// paths, how each of the 17 metrics prints and colors its change, and the sources and feed helpers (import progress,
// callback errors, merging feed pages without losing or repeating an item).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addDays,
  addMonths,
  compareLabel,
  daysIn,
  defaultInterval,
  intervalFromQuery,
  intervalsFor,
  isDay,
  monthGrid,
  periodCount,
  periodEnd,
  periodStart,
  previousRange,
  rangeFor,
  rangeFromQuery,
  rangeQuery,
  shiftMonth,
} from "../src/lib/ranges.ts";
import { areaPath, axisDate, barGeometry, labelIndices, linePath, localDay, nearestIndex, niceStep, niceTicks, periodLabel, stack } from "../src/lib/chart.ts";
import { alignCompare, changeTone, DASHBOARD_METRICS, fmtDelta, fmtMetric, fmtPlotted, METRICS, metricOf, MOVEMENTS, parseMovements, parseSeries, parseSummary, plotValue } from "../src/lib/metrics.ts";
import { connectError, dashboardState, importProgress, lastSynced, looksLikeKey, mergeFeed, olderCursor, parseFeed, parseSources, SOURCE_COLUMNS, type FeedItem, type Source } from "../src/components/sourceState.ts";
import { MINUS } from "../src/lib/format.ts";

const m = (s: string) => s.replace(/-/g, MINUS);

// ---------- Ranges ----------

test("presets end today and count the right days", () => {
  const now = "2026-11-11";
  assert.deepEqual(rangeFor("30d", now), { preset: "30d", from: "2026-10-13", to: now });
  assert.equal(daysIn(rangeFor("30d", now).from, now), 30);
  assert.equal(daysIn(rangeFor("90d", now).from, now), 90);
  assert.deepEqual(rangeFor("12m", now), { preset: "12m", from: "2025-11-12", to: now });
  assert.deepEqual(rangeFor("ytd", now), { preset: "ytd", from: "2026-01-01", to: now });
  // Year to date on Jan 1 is one day.
  assert.equal(daysIn(rangeFor("ytd", "2026-01-01").from, "2026-01-01"), 1);
});

test("a custom range is put in order, never runs past today, and falls back to 30 days when broken", () => {
  const now = "2026-11-11";
  assert.deepEqual(rangeFor("custom", now, { from: "2026-03-31", to: "2026-01-01" }), { preset: "custom", from: "2026-01-01", to: "2026-03-31" });
  assert.deepEqual(rangeFor("custom", now, { from: "2026-11-01", to: "2027-02-01" }), { preset: "custom", from: "2026-11-01", to: now });
  assert.deepEqual(rangeFor("custom", now, { from: "2027-01-01", to: "2027-02-01" }), { preset: "custom", from: now, to: now });
  assert.equal(rangeFor("custom", now, { from: "2026-02-30", to: "2026-03-01" }).preset, "30d");
  assert.equal(rangeFor("custom", now).preset, "30d");
});

test("day math across months, leap years and month ends", () => {
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
  assert.equal(addMonths("2024-02-29", 12), "2025-02-28");
  assert.equal(addMonths("2026-01-15", -13), "2024-12-15");
  assert.ok(isDay("2024-02-29"));
  assert.ok(!isDay("2026-02-29"));
  assert.ok(!isDay("2026-1-1"));
  assert.ok(!isDay(null));
});

test("the previous period is the same length, right before, as metric_summary compares", () => {
  assert.deepEqual(previousRange({ from: "2026-10-13", to: "2026-11-11" }), { from: "2026-09-13", to: "2026-10-12" });
  assert.deepEqual(previousRange({ from: "2026-01-01", to: "2026-01-01" }), { from: "2025-12-31", to: "2025-12-31" });
  const r = { from: "2026-03-01", to: "2026-03-31" };
  const p = previousRange(r);
  assert.equal(daysIn(p.from, p.to), daysIn(r.from, r.to));
  assert.equal(addDays(p.to, 1), r.from);
});

test("periods start on Monday and the 1st, like metric_series", () => {
  assert.equal(periodStart("2026-11-11", "week"), "2026-11-09"); // a Wednesday
  assert.equal(periodStart("2026-11-09", "week"), "2026-11-09"); // Monday stays
  assert.equal(periodStart("2026-11-15", "week"), "2026-11-09"); // Sunday goes back
  assert.equal(periodStart("2026-11-11", "month"), "2026-11-01");
  assert.equal(periodEnd("2026-11-09", "week"), "2026-11-15");
  assert.equal(periodEnd("2026-02-01", "month"), "2026-02-28");
  assert.equal(periodCount({ from: "2026-10-13", to: "2026-11-11" }, "day"), 30);
  assert.equal(periodCount({ from: "2026-11-11", to: "2026-11-23" }, "week"), 3);
  assert.equal(periodCount({ from: "2025-11-12", to: "2026-11-11" }, "month"), 13);
});

test("intervals: at least two periods, at most 400, and a sensible default", () => {
  const now = "2026-11-11";
  assert.equal(defaultInterval(rangeFor("30d", now)), "day");
  assert.equal(defaultInterval(rangeFor("90d", now)), "week");
  assert.equal(defaultInterval(rangeFor("12m", now)), "month");
  assert.deepEqual(intervalsFor(rangeFor("30d", now)), ["day", "week", "month"]);
  // Two years of days is too many; one day has only "day".
  assert.deepEqual(intervalsFor({ from: "2024-11-01", to: now }), ["week", "month"]);
  assert.deepEqual(intervalsFor({ from: now, to: now }), ["day"]);
  assert.equal(defaultInterval({ from: "2026-11-01", to: "2026-11-05" }), "day");
});

test("the range goes into the address and comes back the same", () => {
  const now = "2026-11-11";
  for (const r of [rangeFor("30d", now), rangeFor("90d", now), rangeFor("12m", now), rangeFor("ytd", now), rangeFor("custom", now, { from: "2026-02-01", to: "2026-03-15" })]) {
    assert.deepEqual(rangeFromQuery(rangeQuery(r), now), r);
  }
  assert.equal(rangeQuery(rangeFor("30d", now)), "");
  assert.deepEqual(rangeFromQuery("?range=nope", now), rangeFor("30d", now));
  assert.equal(intervalFromQuery("?every=day", rangeFor("90d", now)), "day");
  assert.equal(intervalFromQuery("?every=day", { from: "2024-01-01", to: now }), "month", "a range too long for days falls back");
  assert.equal(intervalFromQuery("?every=hour", rangeFor("30d", now)), "day");
});

test("the compare label names the window", () => {
  const now = "2026-11-11";
  assert.equal(compareLabel(rangeFor("30d", now)), "previous 30 days");
  assert.equal(compareLabel(rangeFor("12m", now)), "previous 12 months");
  assert.equal(compareLabel(rangeFor("ytd", now)), "previous 315 days");
  assert.equal(compareLabel(rangeFor("custom", now, { from: now, to: now })), "previous day");
  assert.equal(compareLabel(rangeFor("custom", now, { from: "2022-01-01", to: now })), "previous 1,776 days");
});

test("a month grid starts on Monday and holds every day once", () => {
  const nov = monthGrid(2026, 11); // Nov 1, 2026 is a Sunday
  assert.equal(nov[0]!.length, 7);
  assert.deepEqual(nov[0], [null, null, null, null, null, null, "2026-11-01"]);
  const days = nov.flat().filter(Boolean);
  assert.equal(days.length, 30);
  assert.equal(days[29], "2026-11-30");
  assert.equal(monthGrid(2024, 2).flat().filter(Boolean).length, 29);
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
});

// ---------- Charts ----------

test("axis steps are round: 1, 2, 2.5 or 5 times a power of ten", () => {
  assert.equal(niceStep(0.7), 1);
  assert.equal(niceStep(1.6), 2);
  assert.equal(niceStep(2.3), 2.5);
  assert.equal(niceStep(3), 5);
  assert.equal(niceStep(7300), 10000);
  assert.equal(niceStep(0.0031), 0.005);
  assert.equal(niceStep(0), 1);
});

test("bar ticks hold zero and cover every value", () => {
  assert.deepEqual(niceTicks(120, 780), [0, 200, 400, 600, 800]);
  assert.deepEqual(niceTicks(-480, 950), [-500, 0, 500, 1000]);
  const t = niceTicks(-0.013, 0.041);
  assert.ok(t.includes(0) && t[0]! <= -0.013 && t[t.length - 1]! >= 0.041, String(t));
  // Nothing or a single zero still makes an axis.
  assert.deepEqual(niceTicks(0, 0), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(niceTicks(NaN, NaN), [0, 0.25, 0.5, 0.75, 1]);
});

test("line ticks may start above zero, and the lowest tick says where", () => {
  const t = niceTicks(282_000, 294_300, 4, false);
  assert.ok(t[0]! > 0 && t[0]! <= 282_000, String(t));
  assert.ok(t[t.length - 1]! >= 294_300);
  assert.ok(t.length >= 3 && t.length <= 7);
  // A flat line gets a band around it.
  const flat = niceTicks(500, 500, 4, false);
  assert.ok(flat[0]! < 500 && flat[flat.length - 1]! > 500, String(flat));
});

test("date labels: about the asked number, evenly spaced, first and last shown", () => {
  assert.deepEqual(labelIndices(5, 8), [0, 1, 2, 3, 4]);
  const l = labelIndices(30, 6);
  assert.equal(l[0], 0);
  assert.equal(l[l.length - 1], 29);
  assert.ok(l.length <= 7, String(l));
  const gaps = l.slice(1, -1).map((v, i) => v - l[i]!);
  assert.ok(new Set(gaps).size <= 1, "even spacing inside");
  assert.deepEqual(labelIndices(0, 5), []);
  assert.deepEqual(labelIndices(1, 5), [0]);
});

test("chart dates read the same calendar day in any time zone", () => {
  const d = localDay("2026-11-01");
  assert.equal(d.getDate(), 1);
  assert.equal(d.getMonth(), 10);
  assert.equal(axisDate("2026-11-01", "day"), "Nov 1");
  assert.equal(axisDate("2026-11-01", "month"), "Nov '26");
  assert.equal(periodLabel("2026-11-09", "week"), "Week of Nov 9, 2026");
  assert.equal(periodLabel("2026-11-01", "month"), "November 2026");
  assert.equal(periodLabel("2026-11-03", "day"), "Nov 3, 2026");
});

test("paths break at missing values and the area closes to its base", () => {
  assert.equal(linePath([0, 10, 20], [5, 6, 7]), "M0 5L10 6L20 7");
  assert.equal(linePath([0, 10, 20, 30], [5, null, 7, 8]), "M0 5M20 7L30 8");
  assert.equal(linePath([0, 1], [null, null]), "");
  assert.equal(areaPath([0, 10, 20], [5, 6, 7], 100), "M0 100L0 5L10 6L20 7L20 100Z");
  // A lone point has no area.
  assert.equal(areaPath([0, 10, 20], [5, null, 7], 100), "");
});

test("bars leave a gap of a quarter of their width", () => {
  const g = barGeometry(1000, 10);
  assert.equal(g.slot, 100);
  assert.equal(g.bar, 80);
  assert.equal(g.slot - g.bar, g.bar * 0.25);
  assert.equal(barGeometry(10, 100).bar, 1, "never thinner than a pixel");
});

test("movements stack: good from zero up, bad from zero down, zeros take no room", () => {
  assert.deepEqual(
    stack([
      { key: "new", value: 300 },
      { key: "expansion", value: 100 },
      { key: "reactivation", value: 0 },
      { key: "contraction", value: -50 },
      { key: "churn", value: -200 },
    ]),
    [
      { key: "new", from: 0, to: 300 },
      { key: "expansion", from: 300, to: 400 },
      { key: "contraction", from: 0, to: -50 },
      { key: "churn", from: -50, to: -250 },
    ],
  );
  assert.deepEqual(stack([{ key: "new", value: null }]), []);
});

test("hover finds the nearest point", () => {
  assert.equal(nearestIndex([10, 20, 30], 24), 1);
  assert.equal(nearestIndex([10, 20, 30], -5), 0);
  assert.equal(nearestIndex([10, 20, 30], 99), 2);
  assert.equal(nearestIndex([], 5), -1);
});

// ---------- Metrics ----------

test("the 17 metrics are exactly the ones metric_summary returns, in its order", () => {
  const sql = readFileSync("supabase/migrations/009_mrr.sql", "utf8");
  const list = sql.match(/from unnest\(array\[([^\]]+)\]\) with ordinality/)?.[1] ?? "";
  const ids = [...list.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.equal(ids.length, 17);
  assert.deepEqual(METRICS.map((x) => x.id), ids);
  for (const id of DASHBOARD_METRICS) assert.ok(metricOf(id), id);
  for (const mv of MOVEMENTS) assert.ok(metricOf(mv.id)?.flow, mv.id);
  assert.equal(metricOf("nope"), null);
  assert.equal(metricOf("__proto__"), null);
});

test("money arrives in cents and prints in whole units of the workspace currency", () => {
  const mrr = metricOf("mrr")!;
  assert.equal(plotValue(mrr, 4_821_350, "usd"), 48_213.5);
  assert.equal(fmtMetric(mrr, 4_821_350, "usd"), "$48.2K");
  assert.equal(fmtMetric(mrr, "842000", "usd"), "$8,420", "numeric can arrive as text");
  assert.equal(fmtMetric(mrr, 420_000, "eur"), "€4,200");
  assert.equal(fmtMetric(mrr, 4200, "jpy"), "¥4,200", "no minor units");
  assert.equal(fmtMetric(mrr, null, "usd"), "—");
  assert.equal(fmtMetric(metricOf("arr")!, 148_800_000, "usd"), "$1.49M");
});

test("rates, counts and the quick ratio print their own way", () => {
  assert.equal(fmtMetric(metricOf("customer_churn_rate")!, 0.034, "usd"), "3.4%");
  assert.equal(fmtMetric(metricOf("nrr")!, 1.042, "usd"), "104.2%");
  assert.equal(fmtMetric(metricOf("active_customers")!, 1284, "usd"), "1,284");
  assert.equal(fmtMetric(metricOf("quick_ratio")!, 2.437, "usd"), "2.4");
  assert.equal(fmtPlotted(metricOf("ltv")!, null, "usd"), "—");
});

test("a change is a percent of the previous value, or the plain difference from zero", () => {
  const mrr = metricOf("mrr")!;
  assert.equal(fmtDelta(mrr, 110, 100, "usd"), "+10.0%");
  assert.equal(fmtDelta(mrr, 90, 100, "usd"), m("-10.0%"));
  assert.equal(fmtDelta(mrr, 1200, 0, "usd"), "+$1.2K");
  assert.equal(fmtDelta(mrr, 0, 0, "usd"), "$0");
  assert.equal(fmtDelta(metricOf("active_customers")!, 12, 0, "usd"), "+12");
  assert.equal(fmtDelta(metricOf("customer_churn_rate")!, 0.02, 0, "usd"), "+2.0%");
  assert.equal(fmtDelta(metricOf("net_new_mrr")!, -50, -100, "usd"), "+50.0%", "against the size of a negative start");
  assert.equal(fmtDelta(mrr, null, 100, "usd"), "—");
});

test("a change is colored by what it means: churn falling is good", () => {
  assert.equal(changeTone(metricOf("mrr")!, 110, 100), "green");
  assert.equal(changeTone(metricOf("mrr")!, 90, 100), "red");
  assert.equal(changeTone(metricOf("churned_mrr")!, 90, 100), "green");
  assert.equal(changeTone(metricOf("customer_churn_rate")!, 0.04, 0.03), "red");
  assert.equal(changeTone(metricOf("mrr")!, 100, 100), undefined);
  assert.equal(changeTone(metricOf("mrr")!, null, 100), undefined);
});

test("summary, series and movements are checked row by row", () => {
  const s = parseSummary([{ metric: "mrr", value: "100", previous: 90 }, { metric: "bogus", value: 1, previous: 1 }, null]);
  assert.deepEqual(s, { mrr: { value: 100, previous: 90 } });
  assert.deepEqual(parseSummary("nope"), {});
  const series = parseSeries(metricOf("mrr")!, [{ period: "2026-11-02", value: 200 }, { period: "2026-11-01", value: null }, { period: 5, value: 1 }], "usd");
  assert.deepEqual(series, [{ period: "2026-11-01", value: null }, { period: "2026-11-02", value: 2 }]);
  assert.deepEqual(alignCompare(series, [{ period: "2026-10-01", value: 1 }]), [1, null]);
  const rows = parseMovements([
    { day: "2026-11-02", at: "2026-11-02T10:00:00Z", source_id: "s", customer_id: "cus_1", customer_name: "", customer_email: "a@b.co", kind: "churn", amount: -900, mrr_before: 900, mrr_after: 0, currency: "usd" },
    { day: "2026-11-02", customer_id: "cus_2", kind: "refund", amount: 1, mrr_before: 0, mrr_after: 1 },
    { day: "2026-11-02", customer_id: "cus_3", kind: "new", amount: "x", mrr_before: 0, mrr_after: 1 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.customer_name, null);
  assert.equal(rows[0]!.amount, -900);
});

// ---------- Sources and feed ----------

const src = (o: Partial<Source> & { status: Source["status"] }): Source => ({ id: "s1", kind: "stripe_app", account_id: "acct_1", account_name: null, livemode: true, backfill: {}, last_synced_at: null, last_error: null, created_at: "", ...o });

test("sources are read with an explicit column list that leaves out the sealed tokens", () => {
  const cols = SOURCE_COLUMNS.split(",").map((c) => c.trim());
  for (const secret of ["access_token", "refresh_token", "api_key"]) assert.ok(!cols.includes(secret), secret);
  assert.ok(!SOURCE_COLUMNS.includes("*"));
  // Every column asked for is one members are granted (008_stripe.sql).
  const sql = readFileSync("supabase/migrations/008_stripe.sql", "utf8");
  const granted = sql.match(/grant select \(([^)]+)\) on public\.sources to authenticated/)?.[1]?.split(",").map((c) => c.trim()) ?? [];
  for (const c of cols) assert.ok(granted.includes(c), c);
});

test("source rows are checked; bad statuses and shapes drop out", () => {
  const rows = parseSources([
    { id: "a", account_id: "acct_1", status: "live", backfill: { invoices: { count: "12", done: true } }, livemode: false, account_name: "  " },
    { id: "b", account_id: "acct_2", status: "weird" },
    "nope",
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.account_name, null);
  assert.equal(rows[0]!.livemode, false);
  assert.deepEqual(rows[0]!.backfill, { invoices: { cursor: null, done: true, count: 12 } });
});

test("import progress counts what's read so far, in the order the import reads it", () => {
  const p = importProgress({ invoices: { count: 3100, done: false }, customers: { count: 1240, done: true }, coupons: { count: 0, done: true }, prices: { count: 1, done: true } });
  assert.equal(p.text, "1,240 customers, 1 price, 3,100 invoices");
  assert.equal(p.done, false);
  assert.equal(p.total, 4341);
  assert.equal(importProgress({}).done, false);
  assert.equal(importProgress({ customers: { count: 2, done: true } }).done, true);
});

test("the dashboard opens on the numbers as soon as one account is live", () => {
  assert.equal(dashboardState([]), "none");
  assert.equal(dashboardState([src({ status: "disconnected" })]), "none");
  assert.equal(dashboardState([src({ status: "connecting" })]), "importing");
  assert.equal(dashboardState([src({ status: "importing" }), src({ status: "live" })]), "live");
  assert.equal(dashboardState([src({ status: "error" }), src({ status: "importing" })]), "importing");
  assert.equal(dashboardState([src({ status: "error" })]), "error");
  assert.equal(lastSynced([src({ status: "live", last_synced_at: "2026-11-01T00:00:00Z" }), src({ status: "live", last_synced_at: "2026-11-02T00:00:00Z" }), src({ status: "live" })]), "2026-11-02T00:00:00Z");
});

test("callback errors become one short line, unknown codes too", () => {
  assert.equal(connectError(null), "");
  assert.equal(connectError(""), "");
  assert.match(connectError("access_denied"), /wasn't connected/);
  assert.match(connectError("already_connected"), /another workspace/);
  assert.equal(connectError("<script>"), "Couldn't connect Stripe. Try again.");
  // Every code /api/stripe/callback sends has a line.
  for (const c of ["denied", "state", "code", "setup", "exchange", "account", "save", "x"]) assert.ok(connectError(c) && connectError(c).length < 80, c);
  assert.match(connectError("setup"), /restricted key/);
});

test("a pasted key is checked for shape before it's sent", () => {
  assert.ok(looksLikeKey("rk_live_51Habcdefghijk"));
  assert.ok(looksLikeKey(" rk_test_51Habcdefghijk "));
  assert.ok(!looksLikeKey("pk_live_51Habcdefghijk"));
  assert.ok(!looksLikeKey("rk_live_short"));
});

const item = (id: string, at: string, o: Partial<FeedItem> = {}): FeedItem => ({ id, at, kind: "signup", customer_id: "c", customer_name: null, customer_email: null, amount: 100, currency: "usd", original_amount: 100, original_currency: "usd", ...o });

test("feed rows are checked; unknown kinds and bad times drop out", () => {
  const rows = parseFeed([
    { id: "a", at: "2026-11-11T10:00:00.123456+00:00", kind: "cancel", amount: "-900", currency: "usd" },
    { id: "b", at: "2026-11-11T10:00:00Z", kind: "party" },
    { id: "c", at: "not a time", kind: "signup" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.amount, -900);
  assert.equal(rows[0]!.original_amount, -900);
  assert.equal(rows[0]!.original_currency, "usd");
});

test("merging feed pages keeps each item once, newest first, with ties in feed()'s order", () => {
  const a = item("a", "2026-11-11T10:00:00Z");
  const b = item("b", "2026-11-11T09:00:00Z");
  const c1 = item("c", "2026-11-11T08:00:00Z");
  const c2 = item("d", "2026-11-11T08:00:00Z");
  const merged = mergeFeed([a, b, c1], [c2, b, c1]);
  assert.deepEqual(merged.map((f) => f.id), ["a", "b", "d", "c"]);
  // A refresh with an update replaces the old copy.
  assert.equal(mergeFeed([a], [{ ...a, amount: 5 }])[0]!.amount, 5);
  // Out of order and repeated pages give the same list.
  for (let i = 0; i < 20; i++) {
    const pages = [[a, b], [b, c1], [c2], [a, c2]].sort(() => Math.random() - 0.5);
    assert.deepEqual(pages.reduce((acc, p) => mergeFeed(acc, p), [] as FeedItem[]).map((f) => f.id), ["a", "b", "d", "c"]);
  }
});

test("paging back never skips items that share the last moment", () => {
  const last = item("z", "2026-11-11T08:00:00.123456+00:00");
  // Asks from just after the last item, so the rest of that moment comes back (mergeFeed drops the repeats).
  assert.equal(olderCursor([item("a", "2026-11-11T09:00:00Z"), last]), "2026-11-11T08:00:00.124Z");
  // When that brought nothing new, it moves on strictly before.
  assert.equal(olderCursor([last], true), last.at);
  assert.equal(olderCursor([]), null);
});
