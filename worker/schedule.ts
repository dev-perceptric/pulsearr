// Stripe and rate work that runs on a clock, called from the worker's tick each minute:
//   stripe.poll_events  each importing or live source not synced in 5 minutes (due_stripe_polls)
//   stripe.check        each live source once a day, from 03:00 UTC (key `${source_id}:${day}`)
//   fx.load             once a day, from 16:30 UTC, after the ECB publishes (key `${day}`)
// ensureRates runs on worker start: when no rate is less than 5 days old (weekends and holidays have none), fx.load
// runs now. enqueue_job_once keeps each daily job to one, however many workers tick.

import type { Db } from "./pg.ts";

export const CHECK_FROM_UTC_MIN = 3 * 60;
export const FX_FROM_UTC_MIN = 16 * 60 + 30;

const once = (db: Db, ws: string | null, kind: string, key: string, payload: object) =>
  db.query("select public.enqueue_job_once($1, $2, $3, $4::jsonb)", [ws, kind, key, JSON.stringify(payload)]);

export async function scheduleWork(db: Db, now = new Date()): Promise<{ polls: number; checks: number; fx: boolean }> {
  const { rows } = await db.query<{ n: number | null }>("select public.due_stripe_polls(300) as n");
  const polls = Number(rows[0]?.n ?? 0) || 0;
  const day = now.toISOString().slice(0, 10);
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  let checks = 0;
  if (minute >= CHECK_FROM_UTC_MIN) {
    const { rows: live } = await db.query<{ id: string; workspace_id: string }>("select id, workspace_id from public.sources where status = 'live' order by id");
    for (const s of live) {
      await once(db, s.workspace_id, "stripe.check", `${s.id}:${day}`, { source_id: s.id });
      checks++;
    }
  }
  const fx = minute >= FX_FROM_UTC_MIN;
  if (fx) await once(db, null, "fx.load", day, {});
  return { polls, checks, fx };
}

export async function ensureRates(db: Db, now = new Date()): Promise<boolean> {
  const { rows } = await db.query<{ fresh: boolean }>("select exists (select 1 from public.fx_rates where base = 'eur' and day >= $1::date - 5) as fresh", [now.toISOString().slice(0, 10)]);
  if (rows[0]?.fresh) return false;
  await once(db, null, "fx.load", `start:${now.toISOString().slice(0, 10)}`, {});
  return true;
}
