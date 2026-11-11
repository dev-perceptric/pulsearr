// Currency rates for the engine: the latest rate on or before a day (rates skip weekends and holidays), up to
// MAX_STALE_DAYS old. A pair missing both ways goes through another currency, the European Central Bank's euro
// first. No rate at all is an error, never a guess: the job tries again once the nightly rates load.

import { dayText } from "./days.ts";
import { decimal, div, ONE, q, toDecimalText, type Q } from "./rational.ts";
import type { FxRate } from "./types.ts";

export const MAX_STALE_DAYS = 7;

export class MissingRateError extends Error {
  from: string;
  to: string;
  day: string;
  constructor(from: string, to: string, day: string) {
    super(`No ${from.toUpperCase()} to ${to.toUpperCase()} rate on or in the ${MAX_STALE_DAYS} days before ${day}`);
    this.name = "MissingRateError";
    this.from = from;
    this.to = to;
    this.day = day;
  }
}

export type Rate = { rate: Q; text: string };
/** The rate from `from` into the target currency on an epoch day. */
export type RateLookup = (from: string, day: number) => Rate;

type Point = { day: number; rate: Q; text: string };

export function rateFinder(fx: FxRate[], to: string): RateLookup {
  const target = to.toLowerCase();
  const pairs = new Map<string, Point[]>();
  for (const r of fx) {
    const base = r.base.toLowerCase();
    const quote = r.quote.toLowerCase();
    const rate = decimal(r.rate);
    if (rate.n <= 0n || base === quote) continue;
    const key = `${base}>${quote}`;
    const list = pairs.get(key) ?? [];
    list.push({ day: Math.round(Date.parse(`${r.day}T00:00:00Z`) / 86_400_000), rate, text: r.rate });
    pairs.set(key, list);
  }
  // Sorted by day; two rows for one day keep the one whose text sorts last, so input order can't matter.
  for (const [key, list] of pairs) {
    list.sort((a, b) => a.day - b.day || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
    pairs.set(key, list.filter((p, i) => i === list.length - 1 || list[i + 1]!.day !== p.day));
  }
  const currencies = [...new Set([...pairs.keys()].flatMap((k) => k.split(">")))].sort((a, b) => (a === "eur" ? -1 : b === "eur" ? 1 : a < b ? -1 : a > b ? 1 : 0));

  const latest = (list: Point[] | undefined, day: number): Q | null => {
    if (!list?.length) return null;
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.day <= day) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0 || day - list[found]!.day > MAX_STALE_DAYS) return null;
    return list[found]!.rate;
  };
  const direct = (from: string, into: string, day: number): Q | null => {
    if (from === into) return ONE;
    const r = latest(pairs.get(`${from}>${into}`), day);
    if (r) return r;
    const inv = latest(pairs.get(`${into}>${from}`), day);
    return inv ? div(ONE, inv) : null;
  };

  const cache = new Map<string, Rate>();
  return (fromRaw, day) => {
    const from = fromRaw.toLowerCase();
    const key = `${from}:${day}`;
    const hit = cache.get(key);
    if (hit) return hit;
    let rate = direct(from, target, day);
    for (const via of currencies) {
      if (rate) break;
      if (via === from || via === target) continue;
      const a = direct(via, target, day);
      const b = direct(via, from, day);
      if (a && b) rate = div(a, b);
    }
    if (!rate) throw new MissingRateError(from, target, dayText(day));
    const out = { rate, text: rate.d === 1n && rate.n === 1n ? "1" : toDecimalText(rate, 10) };
    cache.set(key, out);
    return out;
  };
}

/** `amount` cents converted at `rate`, exact (round it once, where it's used). */
export const convertCents = (amount: number, rate: Rate): Q => q(BigInt(amount) * rate.rate.n, rate.rate.d);
