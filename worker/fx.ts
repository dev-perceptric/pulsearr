// fx.load: the European Central Bank's reference rates into fx_rates (base 'eur'). Nightly after the ECB
// publishes (worker/schedule.ts), and on worker start when the last few days are missing. The first load, with no
// rates at all, takes the last 90 days (quick) and then the whole history since 1999, so customers billed in
// another currency years ago can still be counted. Free, no key.

import { ECB_90_DAYS, ECB_DAILY, ECB_HISTORY, parseEcb, type EcbRate } from "../src/lib/ecb.ts";
import { JobError } from "../src/lib/jobs.ts";
import { fetchWithRetry, type RetryOptions } from "../src/lib/retry.ts";
import type { Db } from "./pg.ts";

const BATCH = 5000;

export async function saveRates(db: Db, rates: EcbRate[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < rates.length; i += BATCH) {
    const b = rates.slice(i, i + BATCH);
    const { rowCount } = await db.query(
      `insert into public.fx_rates (base, quote, day, rate)
       select 'eur', q, d, r from unnest($1::text[], $2::date[], $3::numeric[]) as x(q, d, r)
       on conflict (base, quote, day) do update set rate = excluded.rate where public.fx_rates.rate <> excluded.rate`,
      [b.map((r) => r.quote), b.map((r) => r.day), b.map((r) => r.rate)],
    );
    n += rowCount ?? 0;
  }
  return n;
}

export async function loadRates(deps: { db: Db; fetch?: typeof fetch; retry?: RetryOptions; log?: (m: string) => void }, signal?: AbortSignal): Promise<{ files: string[]; rates: number }> {
  const { rows } = await deps.db.query<{ any: boolean }>("select exists (select 1 from public.fx_rates where base = 'eur') as any");
  const urls = rows[0]?.any ? [ECB_DAILY] : [ECB_90_DAYS, ECB_HISTORY];
  let rates = 0;
  for (const url of urls) {
    const res = await fetchWithRetry(url, {}, { tries: 4, baseMs: 1000, maxMs: 15_000, fetch: deps.fetch, signal, timeoutMs: 60_000, ...deps.retry });
    if (!res.ok) throw new JobError(`fx.load: ${url} answered ${res.status}`, { retryAfterS: 1800 });
    const parsed = parseEcb(await res.text());
    if (!parsed.length) throw new JobError(`fx.load: no rates in ${url}`, { retryAfterS: 1800 });
    rates += await saveRates(deps.db, parsed);
  }
  (deps.log ?? console.log)(`fx.load: ${rates} rates written from ${urls.length} file(s)`);
  return { files: urls, rates };
}
