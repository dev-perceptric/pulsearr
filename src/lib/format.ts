// Dates and numbers, one way everywhere (docs/brand.md section 10): US English always, so a date never reads one way
// beside US money and another in the next column. Screens call these instead of toLocaleString, toLocaleDateString or
// Intl directly (tests/ui-rules.test.ts fails if one does).
//
// Rounding rules, chosen so a number never says less than the truth:
// - Rounding is half away from zero on the absolute value, without float drift (1.005 rounds to 1.01).
// - Negatives use the real minus sign (U+2212), placed before the currency symbol: −$640.
// - Nothing ever prints "-0", "−$0" or "−0.0%". A value that rounds to zero prints as plain zero, with no sign.
// - Money never hides a loss by rounding: an amount under one whole unit that would round to "$0" shows its cents
//   ("−$0.40"). Only a sub-cent amount counts as zero.
// - Percents and changes round normally to one decimal: −0.04% prints "0.0%" (the sign goes with the zero). A loss of
//   0.05% or more always shows ("−0.1%"). Color a change by its raw value, not by the printed text.
// - Empty input (null, undefined, NaN, an empty string or a bad date) prints "—".

type When = string | number | Date | null | undefined;
type Num = number | null | undefined;

const EMPTY = "—";
/** The real minus sign. */
export const MINUS = "−";

const asDate = (v: When) => (v == null || v === "" ? null : v instanceof Date ? v : new Date(v));
const fmt = (v: When, o: Intl.DateTimeFormatOptions, empty = EMPTY) => {
  const d = asDate(v);
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleString("en-US", o) : empty;
};
const bad = (n: Num): n is null | undefined => n == null || !Number.isFinite(n);

/** |x| rounded to `d` decimals, half away from zero, without float drift. */
const roundAbs = (x: number, d: number) => Math.round(Number((Math.abs(x) * 10 ** d).toPrecision(15))) / 10 ** d;

// ---------- Dates ----------

/** "Nov 10, 2026" (brand default). `year: false` gives "Nov 10"; `weekday` adds "Tue, ". */
export function fmtDate(v: When, opts: { year?: boolean; weekday?: "short" | "long"; month?: "short" | "long" } = {}) {
  const year = opts.year ?? true;
  return fmt(v, { month: opts.month ?? "short", day: "numeric", ...(year ? { year: "numeric" } : {}), ...(opts.weekday ? { weekday: opts.weekday } : {}) });
}

/** Short dates in charts: "Nov 10" for a day, "Nov '26" for a month. */
export function fmtChartDate(v: When, unit: "day" | "month" = "day") {
  if (unit === "day") return fmt(v, { month: "short", day: "numeric" });
  const d = asDate(v);
  if (!d || Number.isNaN(d.getTime())) return EMPTY;
  return `${fmt(d, { month: "short" })} '${fmt(d, { year: "2-digit" })}`;
}

/** "3:05 PM", or "3 PM" on the hour. */
export function fmtTime(v: When) {
  const d = asDate(v);
  return fmt(v, { hour: "numeric", ...(d && d.getMinutes() === 0 ? {} : { minute: "2-digit" }) });
}

/** "Tue, Mar 4, 3:05 PM". */
export function fmtDateTime(v: When, opts: { weekday?: boolean; year?: boolean } = {}) {
  return fmt(v, { ...(opts.weekday === false ? {} : { weekday: "short" }), month: "short", day: "numeric", ...(opts.year ? { year: "numeric" } : {}), hour: "numeric", minute: "2-digit" });
}

/** Any other date shape, still in US English: fmtParts(d, { month: "long", year: "numeric" }) is "March 2025". */
export const fmtParts = (v: When, o: Intl.DateTimeFormatOptions) => fmt(v, o);

/** Time ago, plain: "just now", "4 min ago", "3 hours ago", "yesterday", "5 days ago", then the date. Future times
 *  read "in 4 min", "tomorrow", "in 5 days". */
export function fmtAgo(v: When, now: number = Date.now()) {
  const d = asDate(v);
  if (!d || Number.isNaN(d.getTime())) return EMPTY;
  const diff = (now - d.getTime()) / 1000;
  const future = diff < 0;
  const s = Math.abs(diff);
  if (s < 60) return "just now";
  let text: string;
  if (s < 3600) text = `${Math.floor(s / 60)} min`;
  else if (s < 86400) {
    const h = Math.floor(s / 3600);
    text = h === 1 ? "1 hour" : `${h} hours`;
  } else {
    const days = Math.floor(s / 86400);
    if (days >= 30) return fmtDate(d);
    if (days === 1) return future ? "tomorrow" : "yesterday";
    text = `${days} days`;
  }
  return future ? `in ${text}` : `${text} ago`;
}

// ---------- Counts ----------

/** Counts with commas: "1,284". `digits` caps the decimals (default 3, like toLocaleString). */
export function fmtNum(n: Num, digits?: number) {
  if (bad(n)) return EMPTY;
  const d = digits ?? 3;
  const r = roundAbs(n, d);
  const text = r.toLocaleString("en-US", { maximumFractionDigits: d });
  return n < 0 && r > 0 ? `${MINUS}${text}` : text;
}

// ---------- Money ----------

const minorDigits = (currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
const cur = (abs: number, currency: string, digits: number) => abs.toLocaleString("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
const withCode = (s: string, currency: string, code?: boolean) => (code ? `${s} ${currency.toUpperCase()}` : s);

/** The unsigned text for |n|: full under `fullBelow`, then one decimal and K, then two decimals and M. */
function compact(n: number, currency: string, fullBelow: number): { text: string; zero: boolean } {
  const minor = minorDigits(currency);
  if (roundAbs(n, minor) === 0) return { text: cur(0, currency, 0), zero: true };
  // Under one whole unit it would print "$0": show the cents so a small loss is still seen.
  if (roundAbs(n, 0) === 0) return { text: cur(roundAbs(n, minor), currency, minor), zero: false };
  const whole = roundAbs(n, 0);
  if (whole < fullBelow) return { text: cur(whole, currency, 0), zero: false };
  const k = roundAbs(n / 1_000, 1);
  if (k < 1_000) return { text: `${cur(k, currency, 1)}K`, zero: false };
  return { text: `${cur(roundAbs(n / 1_000_000, 2), currency, 2)}M`, zero: false };
}

type MoneyOpts = { /** Add the currency code, for when more than one currency is on screen: "€4,200 EUR". */ code?: boolean };

/** Money on cards and in text: "$8,420" under $10K, "$48.2K" up to $1M, "$1.24M" above. Negatives "−$8,420". */
export function fmtMoney(n: Num, currency = "USD", o: MoneyOpts = {}) {
  if (bad(n)) return EMPTY;
  const { text, zero } = compact(n, currency, 10_000);
  return withCode(n < 0 && !zero ? `${MINUS}${text}` : text, currency, o.code);
}

/** Money in tables and exports: full, with cents: "$48,213.50", "−$48,213.50". */
export function fmtMoneyExact(n: Num, currency = "USD", o: MoneyOpts = {}) {
  if (bad(n)) return EMPTY;
  const minor = minorDigits(currency);
  const r = roundAbs(n, minor);
  const text = cur(r, currency, minor);
  return withCode(n < 0 && r > 0 ? `${MINUS}${text}` : text, currency, o.code);
}

/** A change in money, always signed: "+$1.2K", "−$640", "+$1.24M". Full under $1K; "$0" when nothing changed. */
export function fmtMoneyChange(n: Num, currency = "USD", o: MoneyOpts = {}) {
  if (bad(n)) return EMPTY;
  const { text, zero } = compact(n, currency, 1_000);
  return withCode(zero ? text : `${n < 0 ? MINUS : "+"}${text}`, currency, o.code);
}

// ---------- Percents ----------

function pct(ratio: number, plus: boolean) {
  const v = ratio * 100;
  const r = roundAbs(v, 1);
  const text = `${r.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  if (r === 0) return text;
  return v < 0 ? `${MINUS}${text}` : plus ? `+${text}` : text;
}

/** A share, from a ratio: 0.034 is "3.4%". One decimal. */
export const fmtPercent = (ratio: Num) => (bad(ratio) ? EMPTY : pct(ratio, false));

/** A change, from a ratio, always signed: 0.123 is "+12.3%", −0.021 is "−2.1%", and no change is "0.0%". */
export const fmtChange = (ratio: Num) => (bad(ratio) ? EMPTY : pct(ratio, true));
