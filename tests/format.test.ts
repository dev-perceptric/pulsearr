// Number and date formats from docs/brand.md section 10. Every rule, its boundaries, and the promise that rounding
// never changes a sign or hides a loss.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MINUS, fmtAgo, fmtChange, fmtChartDate, fmtDate, fmtMoney, fmtMoneyChange, fmtMoneyExact, fmtNum, fmtPercent, fromMinor } from "../src/lib/format.ts";

const m = (s: string) => s.replace(/-/g, MINUS); // write expected negatives with "-" for readability

test("the minus sign is the real one (U+2212), never a hyphen", () => {
  assert.equal(MINUS, "−");
  for (const s of [fmtMoney(-640), fmtMoneyExact(-48213.5), fmtMoneyChange(-640), fmtPercent(-0.021), fmtChange(-0.021), fmtNum(-1284)]) {
    assert.ok(s.startsWith(MINUS), s);
    assert.ok(!s.includes("-"), s);
  }
});

test("money under $10K is full with no cents", () => {
  assert.equal(fmtMoney(8420), "$8,420");
  assert.equal(fmtMoney(8420.49), "$8,420");
  assert.equal(fmtMoney(8420.5), "$8,421");
  assert.equal(fmtMoney(1), "$1");
  assert.equal(fmtMoney(9999), "$9,999");
  assert.equal(fmtMoney(-640), m("-$640"));
});

test("money from $10K is one decimal and K; 9,999 vs 10,000 is the boundary", () => {
  assert.equal(fmtMoney(10_000), "$10.0K");
  assert.equal(fmtMoney(9_999.4), "$9,999");
  // Rounds to 10,000 whole, so it reads in K rather than as "$10,000".
  assert.equal(fmtMoney(9_999.5), "$10.0K");
  assert.equal(fmtMoney(48_213), "$48.2K");
  assert.equal(fmtMoney(48_250), "$48.3K");
  assert.equal(fmtMoney(-48_213), m("-$48.2K"));
  assert.equal(fmtMoney(999_949), "$999.9K");
});

test("money from $1M is two decimals and M; 999,999 vs 1,000,000 is the boundary", () => {
  // 999,999 would read "$1000.0K": it moves up to M instead.
  assert.equal(fmtMoney(999_950), "$1.00M");
  assert.equal(fmtMoney(999_999), "$1.00M");
  assert.equal(fmtMoney(1_000_000), "$1.00M");
  assert.equal(fmtMoney(1_240_000), "$1.24M");
  assert.equal(fmtMoney(1_245_000), "$1.25M");
  assert.equal(fmtMoney(-1_240_000), m("-$1.24M"));
  assert.equal(fmtMoney(1_500_000_000), "$1,500.00M");
});

test("money zero, empty and tiny amounts: never -$0, and a loss under a dollar still shows", () => {
  assert.equal(fmtMoney(0), "$0");
  assert.equal(fmtMoney(-0), "$0");
  assert.equal(fmtMoney(-0.004), "$0");
  assert.equal(fmtMoney(0.004), "$0");
  assert.equal(fmtMoney(-0.4), m("-$0.40"));
  assert.equal(fmtMoney(0.4), "$0.40");
  assert.equal(fmtMoney(-0.5), m("-$1"));
  assert.equal(fmtMoney(null), "—");
  assert.equal(fmtMoney(undefined), "—");
  assert.equal(fmtMoney(Number.NaN), "—");
  assert.equal(fmtMoney(Number.POSITIVE_INFINITY), "—");
});

test("money in tables and exports is full with cents", () => {
  assert.equal(fmtMoneyExact(48_213.5), "$48,213.50");
  assert.equal(fmtMoneyExact(-48_213.5), m("-$48,213.50"));
  assert.equal(fmtMoneyExact(1_240_000), "$1,240,000.00");
  assert.equal(fmtMoneyExact(0), "$0.00");
  assert.equal(fmtMoneyExact(-0.004), "$0.00");
  assert.equal(fmtMoneyExact(-0.005), m("-$0.01"));
  // Half away from zero, with no float drift.
  assert.equal(fmtMoneyExact(1.005), "$1.01");
  assert.equal(fmtMoneyExact(-1.005), m("-$1.01"));
  assert.equal(fmtMoneyExact(null), "—");
});

test("money changes are always signed: full under $1K, then K and M", () => {
  assert.equal(fmtMoneyChange(1_200), "+$1.2K");
  assert.equal(fmtMoneyChange(-640), m("-$640"));
  assert.equal(fmtMoneyChange(640), "+$640");
  assert.equal(fmtMoneyChange(999), "+$999");
  assert.equal(fmtMoneyChange(999.5), "+$1.0K");
  assert.equal(fmtMoneyChange(1_000), "+$1.0K");
  assert.equal(fmtMoneyChange(-48_213), m("-$48.2K"));
  assert.equal(fmtMoneyChange(2_500_000), "+$2.50M");
  assert.equal(fmtMoneyChange(0), "$0");
  assert.equal(fmtMoneyChange(-0.001), "$0");
  assert.equal(fmtMoneyChange(-0.4), m("-$0.40"));
  assert.equal(fmtMoneyChange(null), "—");
});

test("other currencies, always in en-US, with the code when asked", () => {
  assert.equal(fmtMoney(4_200, "EUR"), "€4,200");
  assert.equal(fmtMoney(4_200, "EUR", { code: true }), "€4,200 EUR");
  assert.equal(fmtMoney(48_213, "GBP"), "£48.2K");
  assert.equal(fmtMoney(-1_240_000, "EUR"), m("-€1.24M"));
  assert.equal(fmtMoneyExact(48_213.5, "EUR", { code: true }), "€48,213.50 EUR");
  assert.equal(fmtMoneyChange(1_200, "eur", { code: true }), "+€1.2K EUR");
  // Yen has no minor unit: exact amounts have no decimals, and nothing under one yen exists.
  assert.equal(fmtMoneyExact(4_200, "JPY"), "¥4,200");
  assert.equal(fmtMoney(-0.4, "JPY"), "¥0");
});

test("percent is one decimal, from a ratio", () => {
  assert.equal(fmtPercent(0.034), "3.4%");
  assert.equal(fmtPercent(0.0345), "3.5%");
  assert.equal(fmtPercent(1), "100.0%");
  assert.equal(fmtPercent(12.345), "1,234.5%");
  assert.equal(fmtPercent(0), "0.0%");
  assert.equal(fmtPercent(-0.021), m("-2.1%"));
  assert.equal(fmtPercent(null), "—");
});

test("change is signed and one decimal; it rounds normally but never prints -0.0%", () => {
  assert.equal(fmtChange(0.123), "+12.3%");
  assert.equal(fmtChange(-0.021), m("-2.1%"));
  assert.equal(fmtChange(0), "0.0%");
  assert.equal(fmtChange(-0), "0.0%");
  // Under half a tenth of a point rounds to zero, shown without a sign.
  assert.equal(fmtChange(-0.0004), "0.0%");
  assert.equal(fmtChange(0.0004), "0.0%");
  assert.equal(fmtPercent(-0.0004), "0.0%");
  // From half a tenth of a point the loss shows.
  assert.equal(fmtChange(-0.0005), m("-0.1%"));
  assert.equal(fmtChange(0.0005), "+0.1%");
  // Rounding never flips the sign of a real change.
  for (const r of [-0.5, -0.0999, -0.00051, 0.00051, 0.0999, 0.5]) {
    const s = fmtChange(r);
    assert.ok(r < 0 ? s.startsWith(MINUS) : s.startsWith("+"), `${r} -> ${s}`);
  }
  assert.equal(fmtChange(undefined), "—");
});

test("counts have commas", () => {
  assert.equal(fmtNum(1284), "1,284");
  assert.equal(fmtNum(0), "0");
  assert.equal(fmtNum(-1284), m("-1,284"));
  assert.equal(fmtNum(-0.0001), "0");
  assert.equal(fmtNum(12.3456, 1), "12.3");
  assert.equal(fmtNum(null), "—");
});

test("dates are Mon D, YYYY; chart dates are Mon D or Mon 'YY", () => {
  const d = new Date(2026, 10, 10, 12, 0);
  assert.equal(fmtDate(d), "Nov 10, 2026");
  assert.equal(fmtDate(d, { year: false }), "Nov 10");
  assert.equal(fmtChartDate(d), "Nov 10");
  assert.equal(fmtChartDate(d, "month"), "Nov '26");
  assert.equal(fmtDate(null), "—");
  assert.equal(fmtDate("not a date"), "—");
  assert.equal(fmtChartDate("", "month"), "—");
});

test("time ago is plain words", () => {
  const now = new Date(2026, 10, 11, 12, 0).getTime();
  const ago = (s: number) => fmtAgo(new Date(now - s * 1000), now);
  assert.equal(ago(10), "just now");
  assert.equal(ago(-10), "just now");
  assert.equal(ago(4 * 60), "4 min ago");
  assert.equal(ago(59 * 60 + 59), "59 min ago");
  assert.equal(ago(3600), "1 hour ago");
  assert.equal(ago(3 * 3600), "3 hours ago");
  assert.equal(ago(26 * 3600), "yesterday");
  assert.equal(ago(-26 * 3600), "tomorrow");
  assert.equal(ago(5 * 86400), "5 days ago");
  assert.equal(ago(-5 * 86400), "in 5 days");
  assert.equal(ago(-4 * 60), "in 4 min");
  assert.equal(ago(40 * 86400), "Oct 2, 2026");
  assert.equal(fmtAgo(null), "—");
});

test("minor units turn into whole units by the currency's own digits", () => {
  assert.equal(fromMinor(4_821_350, "usd"), 48_213.5);
  assert.equal(fromMinor(-64_000, "USD"), -640);
  assert.equal(fromMinor(4200, "JPY"), 4200);
  assert.equal(fromMinor(1234, "kwd"), 1.234);
  assert.equal(fromMinor(0, "eur"), 0);
  assert.equal(fromMinor(null), null);
  assert.equal(fromMinor(NaN), null);
  // A one-cent loss still shows after the conversion.
  assert.equal(fmtMoney(fromMinor(-1, "usd")), m("-$0.01"));
});
