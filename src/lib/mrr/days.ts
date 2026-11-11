// UTC days. Stripe times are unix seconds; the engine works in "epoch days" (whole days since 1970-01-01 UTC) and
// prints them as YYYY-MM-DD. A day's MRR is the MRR in force at its last second.

export const DAY_S = 86_400;

/** The epoch day a unix time falls on. */
export const dayOf = (t: number) => Math.floor(t / DAY_S);
/** The first second of an epoch day. */
export const dayStart = (d: number) => d * DAY_S;
/** The last second of an epoch day. */
export const dayEnd = (d: number) => d * DAY_S + DAY_S - 1;

/** An epoch day as YYYY-MM-DD. */
export const dayText = (d: number) => new Date(d * DAY_S * 1000).toISOString().slice(0, 10);

/** YYYY-MM-DD as an epoch day. Throws on anything else, or on a date that doesn't exist (2026-02-30). */
export function parseDay(s: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new RangeError(`Not a day: ${JSON.stringify(s)}`);
  const ms = Date.parse(`${s}T00:00:00Z`);
  const d = ms / 1000 / DAY_S;
  if (!Number.isInteger(d) || dayText(d) !== s) throw new RangeError(`Not a day: ${JSON.stringify(s)}`);
  return d;
}
