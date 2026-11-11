// The queue's Rpc over pg: the SQL functions called straight in Postgres with named arguments, so src/lib/jobs.ts
// runs the same in the worker as over supabase-js.

import type { Rpc } from "../src/lib/jobs.ts";

/** Just what the worker needs from a pg Pool or Client, so tests can pass a fake. */
type Queryable = {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; fields?: { name: string }[]; rowCount?: number | null }>;
};
/** One connection taken from a pool (a transaction runs on one). */
export type DbClient = Queryable & { release: (err?: Error | boolean) => void };
export type Db = Queryable & {
  /** A pool's own connection, for a transaction (inTransaction). */
  connect?: () => Promise<DbClient>;
};

/** Run `fn` inside one transaction on one connection of the pool. Rolled back if `fn` throws. */
export async function inTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  if (!db.connect) throw new Error("This database handle can't open a transaction");
  const c = await db.connect();
  let broken = false;
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {
      broken = true;
    });
    throw e;
  } finally {
    c.release(broken);
  }
}

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** `select * from public.fn(p_a => $1, ...)`. A function that returns one value answers that value; a set, its rows. */
export function rpcSql(fn: string, args: Record<string, unknown>): { text: string; values: unknown[] } {
  if (!NAME.test(fn)) throw new Error(`Bad function name: ${fn}`);
  const names = Object.keys(args).filter((n) => args[n] !== undefined);
  for (const n of names) if (!NAME.test(n)) throw new Error(`Bad argument name: ${n}`);
  const list = names.map((n, i) => `${n} => $${i + 1}`).join(", ");
  // Objects go as JSON text (for jsonb arguments); arrays as Postgres arrays, which pg does itself.
  const values = names.map((n) => {
    const v = args[n];
    return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) ? JSON.stringify(v) : v;
  });
  return { text: `select * from public.${fn}(${list})`, values };
}

export function pgRpc(db: Db): Rpc {
  return async (fn, args) => {
    try {
      const { text, values } = rpcSql(fn, args);
      const res = await db.query(text, values);
      const fields = res.fields ?? [];
      // One column named after the function: a single value (boolean, uuid, int; "" for void).
      if (fields.length === 1 && fields[0]!.name === fn) return { data: res.rows[0]?.[fn] ?? null, error: null };
      return { data: res.rows, error: null };
    } catch (e) {
      const err = e as { message?: string; code?: string };
      return { data: null, error: { message: err.message ?? String(e), code: err.code } };
    }
  };
}
