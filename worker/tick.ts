// Scheduled work, once a minute: clear out old finished jobs (prune_jobs) and stale rate-limit buckets
// (prune_rate_buckets), and log the queue when it has work.

import { sleep } from "../src/lib/retry.ts";
import type { Db } from "./pg.ts";

export async function tickOnce(db: Db, log: (msg: string) => void = console.log): Promise<{ pruned: number; counts: Record<string, number> }> {
  const pruned = Number((await db.query<{ n: number | null }>("select public.prune_jobs() as n")).rows[0]?.n ?? 0) || 0;
  // Rate-limit buckets that are never used again are only cleared here (take_rate clears a bucket when it's used).
  await db.query("select public.prune_rate_buckets()");
  const { rows } = await db.query<{ status: string; n: string }>(
    "select status, count(*)::text as n from public.jobs where status in ('queued', 'running') group by status",
  );
  const counts: Record<string, number> = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  if (pruned || rows.length) log(`tick: pruned ${pruned}, queued ${counts.queued ?? 0}, running ${counts.running ?? 0}`);
  return { pruned, counts };
}

/** Run tickOnce every `everyMs` until `signal` aborts. A failed tick is logged and the next one runs on time. */
export async function tickLoop(o: { db: Db; signal: AbortSignal; everyMs?: number; log?: (msg: string) => void }): Promise<void> {
  const log = o.log ?? console.log;
  while (!o.signal.aborted) {
    try {
      await tickOnce(o.db, log);
    } catch (e) {
      log(`tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(o.everyMs ?? 60_000, o.signal).catch(() => undefined);
  }
}
