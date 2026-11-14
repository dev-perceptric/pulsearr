// A connected Stripe source in the worker: load it, call Stripe as it (its restricted key, or its Stripe App access
// token, refreshed under a row lock), and write what Stripe returns into the clean tables.
//
// Token refresh (stripe_app): Stripe rolls the refresh token on every refresh and the old one stops working, so two
// workers must never refresh at once and the new pair must be saved before the access token is used. The refresh
// runs in one transaction holding `select ... for update` on the source row; a worker that waited for the lock
// finds the new token and uses it instead of refreshing again. A refresh token Stripe no longer accepts marks the
// source 'error' ("Connect Stripe again") and stops the job.

import { JobError } from "../../src/lib/jobs.ts";
import type { RetryOptions } from "../../src/lib/retry.ts";
import { seal, unseal } from "../../src/lib/seal.ts";
import { TABLES, dedupe, isDeadGrant, refreshTokens, StripeError, stripeClient, upsertSql, type Row, type StripeClient, type TableName } from "../../src/lib/stripe/index.ts";
import { enqueueJob } from "../../src/lib/jobs.ts";
import { inTransaction, pgRpc, type Db } from "../pg.ts";

export type BackfillState = { cursor?: string | null; count?: number; done?: boolean; boundary?: number; run?: string; customers?: number; finished_at?: string; parts?: string[]; part?: string | null };

export type Source = {
  id: string;
  workspace_id: string;
  kind: "stripe_app" | "stripe_key";
  account_id: string;
  livemode: boolean;
  status: "connecting" | "importing" | "live" | "error" | "disconnected";
  backfill: Record<string, BackfillState>;
  last_event_id: string | null;
  last_event_at: string | null;
  created_at: string;
};

export type StripeDeps = {
  db: Db;
  fetch?: typeof fetch;
  /** The platform's secret key, for token refresh (STRIPE_SECRET_KEY). */
  secretKey?: () => string;
  retry?: RetryOptions;
  now?: () => number;
  log?: (msg: string) => void;
  /** Today's UTC day (YYYY-MM-DD). */
  today?: () => string;
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Refresh access tokens this long before they run out. */
const REFRESH_EARLY_MS = 5 * 60_000;
export const RECONNECT = "Stripe access was removed. Connect Stripe again.";

export async function loadSource(db: Db, id: unknown): Promise<Source | null> {
  if (typeof id !== "string" || !UUID.test(id)) throw new JobError(`bad source_id ${JSON.stringify(id)}`, { retry: false });
  const { rows } = await db.query<Source>(
    `select id, workspace_id, kind, account_id, livemode, status, backfill, last_event_id, last_event_at::text as last_event_at, created_at::text as created_at
       from public.sources where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

type Secrets = { api_key: string | null; access_token: string | null; refresh_token: string | null; expires_ms: string | null };

const secretsSql = `select api_key, access_token, refresh_token, (extract(epoch from token_expires_at) * 1000)::bigint::text as expires_ms
                      from public.sources where id = $1`;

async function markError(db: Db, sourceId: string, message: string) {
  await db.query("update public.sources set status = 'error', last_error = $2, updated_at = now() where id = $1 and status <> 'disconnected'", [sourceId, message]);
}

/** Refresh the tokens of a stripe_app source under the row lock. `used` is the token Stripe refused (or null). */
export async function refreshSourceToken(deps: StripeDeps, sourceId: string, used: string | null): Promise<string> {
  const now = deps.now ?? Date.now;
  const secretKey = deps.secretKey?.() ?? process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  const outcome = await inTransaction(deps.db, async (tx) => {
    const { rows } = await tx.query<Secrets>(`${secretsSql} for update`, [sourceId]);
    const row = rows[0];
    if (!row) return { gone: true as const };
    const current = row.access_token ? unseal(row.access_token) : null;
    // Another worker refreshed while this one waited for the lock: use its token.
    if (current && current !== used && Number(row.expires_ms) > now() + REFRESH_EARLY_MS) return { token: current };
    if (!row.refresh_token) return { dead: true as const };
    try {
      const t = await refreshTokens(unseal(row.refresh_token), secretKey, { fetch: deps.fetch, retry: deps.retry, now });
      // Saved (and committed with the transaction) before the access token is used anywhere.
      await tx.query("update public.sources set access_token = $2, refresh_token = $3, token_expires_at = to_timestamp($4::double precision / 1000), updated_at = now() where id = $1", [
        sourceId,
        seal(t.accessToken),
        seal(t.refreshToken),
        t.expiresAt,
      ]);
      return { token: t.accessToken };
    } catch (e) {
      if (isDeadGrant(e)) return { dead: true as const };
      throw e;
    }
  });
  if ("gone" in outcome) throw new JobError("The source was removed", { retry: false });
  if ("dead" in outcome) {
    await markError(deps.db, sourceId, RECONNECT);
    throw new JobError(RECONNECT, { retry: false });
  }
  return outcome.token;
}

/** A Stripe client that acts as the source. */
export function sourceClient(deps: StripeDeps, source: Pick<Source, "id" | "kind">, signal?: AbortSignal): StripeClient {
  const now = deps.now ?? Date.now;
  let cached: { token: string; until: number } | null = null;
  const read = async () => {
    const { rows } = await deps.db.query<Secrets>(secretsSql, [source.id]);
    if (!rows[0]) throw new JobError("The source was removed", { retry: false });
    return rows[0];
  };
  if (source.kind === "stripe_key") {
    return stripeClient({
      fetch: deps.fetch,
      signal,
      retry: deps.retry,
      auth: {
        token: async () => {
          if (cached) return cached.token;
          const row = await read();
          if (!row.api_key) throw new JobError("The source has no key", { retry: false });
          cached = { token: unseal(row.api_key), until: Infinity };
          return cached.token;
        },
      },
    });
  }
  return stripeClient({
    fetch: deps.fetch,
    signal,
    retry: deps.retry,
    auth: {
      token: async () => {
        if (cached && cached.until > now() + REFRESH_EARLY_MS) return cached.token;
        const row = await read();
        const expires = Number(row.expires_ms) || 0;
        if (row.access_token && expires > now() + REFRESH_EARLY_MS) {
          cached = { token: unseal(row.access_token), until: expires };
          return cached.token;
        }
        const token = await refreshSourceToken(deps, source.id, null);
        cached = { token, until: now() + 55 * 60_000 };
        return token;
      },
      refresh: async (used) => {
        const token = await refreshSourceToken(deps, source.id, used);
        cached = { token, until: now() + 55 * 60_000 };
        return token;
      },
    },
  });
}

/**
 * What a Stripe failure means for a job: a 429 that never cleared waits without using an attempt; a key or token
 * that no longer works marks the source and stops; another 4xx is a mistake that won't change by trying again.
 */
export async function stripeFailure(db: Db, source: Pick<Source, "id" | "kind">, e: unknown, what: string): Promise<never> {
  if (e instanceof StripeError) {
    if (e.status === 429) throw new JobError(`${what}: Stripe asked us to slow down`, { waitS: 30 });
    if (e.status === 401 && source.kind === "stripe_key") {
      await markError(db, source.id, "Stripe stopped accepting this key. Add a new one.");
      throw new JobError(`${what}: the key no longer works`, { retry: false });
    }
    if (e.status >= 400 && e.status < 500) {
      await db.query("update public.sources set last_error = $2, updated_at = now() where id = $1", [source.id, `${what}: ${e.message}`.slice(0, 2000)]);
      throw new JobError(`${what}: Stripe ${e.status} ${e.message}`, { retry: false });
    }
  }
  throw e;
}

// ---------- writing ----------

/** JSON for Postgres: jsonb can't hold \u0000. */
const pgJson = (v: unknown) => JSON.stringify(v).replace(/(?<!\\)\\u0000/g, "");

/** Upsert rows into one clean table, as fetched at `fetchedAt` (ISO). Rows without their key are dropped. */
export async function upsertRows(db: Db, source: Pick<Source, "id" | "workspace_id">, table: TableName, rows: Row[], fetchedAt: string): Promise<number> {
  const key = TABLES[table].key;
  const clean = dedupe(
    rows.filter((r) => key.every((k) => typeof r[k] === "string" && r[k] !== "")),
    key,
  );
  for (let i = 0; i < clean.length; i += 500) {
    await db.query(upsertSql(table), [source.id, source.workspace_id, pgJson(clean.slice(i, i + 500)), fetchedAt]);
  }
  return clean.length;
}

/** Enqueue a rebuild of each customer (keyed, so a burst runs once). */
export async function enqueueRebuilds(db: Db, source: Pick<Source, "id" | "workspace_id">, customers: Iterable<string>, delayS = 0): Promise<number> {
  const rpc = pgRpc(db);
  let n = 0;
  for (const c of new Set(customers)) {
    if (!/^cus_[A-Za-z0-9]+$/.test(c)) continue;
    await enqueueJob(rpc, {
      workspaceId: source.workspace_id,
      kind: "mrr.rebuild_customer",
      key: `${source.id}:${c}`,
      payload: { workspace_id: source.workspace_id, source_id: source.id, customer_id: c },
      delayS,
    });
    n++;
  }
  return n;
}
