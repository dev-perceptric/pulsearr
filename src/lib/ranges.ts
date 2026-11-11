// Date ranges for the dashboard and metric pages: the presets, the window just before a range (to compare with),
// which intervals make sense for a range, and the range as it sits in the address (?range=90d, ?from=&to=). Days are
// UTC calendar days written "YYYY-MM-DD", the same days mrr_daily counts (009_mrr.sql). Pure, so it's tested in Node.

import { fmtNum } from "./format.ts";

export type Preset = "30d" | "90d" | "12m" | "ytd" | "custom";
export type Interval = "day" | "week" | "month";
export type Range = { preset: Preset; from: string; to: string };

export const PRESETS: { value: Preset; label: string }[] = [
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "12m", label: "Last 12 months" },
  { value: "ytd", label: "Year to date" },
  { value: "custom", label: "Custom" },
];

export const INTERVALS: { value: Interval; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

const DAY_MS = 86_400_000;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A day as milliseconds at UTC midnight, or NaN when it isn't a real "YYYY-MM-DD" day. */
export function dayMs(day: string): number {
  const m = ISO.exec(day);
  if (!m) return NaN;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Reject days that roll over (2026-02-30).
  return new Date(ms).toISOString().slice(0, 10) === day ? ms : NaN;
}

export const isDay = (v: unknown): v is string => typeof v === "string" && Number.isFinite(dayMs(v));
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Today in UTC. */
export const today = (now: number = Date.now()) => dayOf(now);
export const addDays = (day: string, n: number) => dayOf(dayMs(day) + n * DAY_MS);
/** Days in [from, to], both counted: the same day is 1. */
export const daysIn = (from: string, to: string) => Math.round((dayMs(to) - dayMs(from)) / DAY_MS) + 1;

/** The same day `n` months later (earlier for negative n), kept inside the month: Mar 31 less one month is Feb 28. */
export function addMonths(day: string, n: number): string {
  const d = new Date(dayMs(day));
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return dayOf(Date.UTC(y, mo, Math.min(d.getUTCDate(), last)));
}

/** A preset's days, ending today. Custom keeps its own days, put in order and never past today. */
export function rangeFor(preset: Preset, now: string, custom?: { from: string; to: string }): Range {
  switch (preset) {
    case "30d":
      return { preset, from: addDays(now, -29), to: now };
    case "90d":
      return { preset, from: addDays(now, -89), to: now };
    case "12m":
      return { preset, from: addDays(addMonths(now, -12), 1), to: now };
    case "ytd":
      return { preset, from: `${now.slice(0, 4)}-01-01`, to: now };
    case "custom": {
      if (!custom || !isDay(custom.from) || !isDay(custom.to)) return rangeFor("30d", now);
      let [from, to] = custom.from <= custom.to ? [custom.from, custom.to] : [custom.to, custom.from];
      if (to > now) to = now;
      if (from > to) from = to;
      return { preset, from, to };
    }
  }
}

/** The window of the same length just before a range, as metric_summary compares (009_mrr.sql). */
export function previousRange(r: { from: string; to: string }): { from: string; to: string } {
  const n = daysIn(r.from, r.to);
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
}

/** Periods metric_series would return for a range and interval (weeks start Monday, months on the 1st). */
export function periodCount(r: { from: string; to: string }, interval: Interval): number {
  const start = periodStart(r.from, interval);
  if (interval === "day") return daysIn(r.from, r.to);
  if (interval === "week") return Math.floor((dayMs(r.to) - dayMs(start)) / (7 * DAY_MS)) + 1;
  const a = new Date(dayMs(start));
  const b = new Date(dayMs(r.to));
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() + 1;
}

/** The first day of the period holding `day`: itself, its Monday, or the 1st of its month. */
export function periodStart(day: string, interval: Interval): string {
  if (interval === "day") return day;
  if (interval === "month") return `${day.slice(0, 7)}-01`;
  const dow = new Date(dayMs(day)).getUTCDay(); // 0 Sunday
  return addDays(day, -((dow + 6) % 7));
}

/** The last day of the period that starts on `start`. */
export function periodEnd(start: string, interval: Interval): string {
  if (interval === "day") return start;
  if (interval === "week") return addDays(start, 6);
  return addDays(addMonths(start, 1), -1);
}

/** Intervals worth drawing for a range: at least 2 periods and at most 400. */
export function intervalsFor(r: { from: string; to: string }): Interval[] {
  const ok = INTERVALS.map((i) => i.value).filter((i) => {
    const n = periodCount(r, i);
    return n >= 2 && n <= 400;
  });
  return ok.length ? ok : ["day"];
}

/** The interval a range opens with: days up to about two months, weeks up to about seven, then months. */
export function defaultInterval(r: { from: string; to: string }): Interval {
  const n = daysIn(r.from, r.to);
  const pick: Interval = n <= 62 ? "day" : n <= 210 ? "week" : "month";
  const ok = intervalsFor(r);
  return ok.includes(pick) ? pick : ok[0]!;
}

/** "previous 30 days", for "+4.2% vs. previous 30 days". */
export function compareLabel(r: Range): string {
  if (r.preset === "12m") return "previous 12 months";
  const n = daysIn(r.from, r.to);
  return n === 1 ? "previous day" : `previous ${fmtNum(n)} days`;
}

const PRESET_SET = new Set<string>(PRESETS.map((p) => p.value));

/** The range in an address's query: ?range=90d, or ?range=custom&from=2026-01-01&to=2026-03-31. Anything else: 30 days. */
export function rangeFromQuery(search: string, now: string): Range {
  const q = new URLSearchParams(search);
  const preset = q.get("range") ?? "";
  if (!PRESET_SET.has(preset)) return rangeFor("30d", now);
  return rangeFor(preset as Preset, now, { from: q.get("from") ?? "", to: q.get("to") ?? "" });
}

/** The query that opens this range again (no leading "?"); empty for the default. */
export function rangeQuery(r: Range): string {
  if (r.preset === "30d") return "";
  if (r.preset !== "custom") return `range=${r.preset}`;
  return `range=custom&from=${r.from}&to=${r.to}`;
}

/** The interval in the query (?every=week), when it's one the range allows. */
export function intervalFromQuery(search: string, r: { from: string; to: string }): Interval {
  const v = new URLSearchParams(search).get("every");
  const ok = intervalsFor(r);
  return v && (ok as string[]).includes(v) ? (v as Interval) : defaultInterval(r);
}

/** A month as calendar weeks from Monday: each cell is a day, or null outside the month. `month` is 1 to 12. */
export function monthGrid(year: number, month: number): (string | null)[][] {
  const first = Date.UTC(year, month - 1, 1);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = (new Date(first).getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: days }, (_, i) => dayOf(first + i * DAY_MS))];
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** The month after (or before, with -1) a "YYYY-MM" month. */
export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
