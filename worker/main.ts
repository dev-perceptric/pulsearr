// The PulseARR worker: claims jobs straight from Postgres (DATABASE_URL), runs up to WORKER_CONCURRENCY at once
// (default 4), and runs the tick each minute. On SIGTERM it stops claiming and gives running jobs 25 seconds.

import { hostname } from "node:os";
import pg from "pg";
import { databaseUrl, envVar } from "../src/lib/env.ts";
import { jobLoop } from "../src/lib/jobs.ts";
import { makeHandlers } from "./handlers.ts";
import { pgRpc } from "./pg.ts";
import { tickLoop } from "./tick.ts";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

async function main() {
  const url = databaseUrl();
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const concurrency = Math.max(1, Math.min(32, Number(envVar("WORKER_CONCURRENCY")) || 4));
  const pool = new pg.Pool({
    connectionString: url,
    max: concurrency + 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "pulsearr-worker",
  });
  // A dropped idle connection must not stop the worker; the pool opens a new one.
  pool.on("error", (e) => log(`pg pool: ${e.message}`));

  const stop = new AbortController();
  const onSignal = (sig: string) => {
    if (stop.signal.aborted) return;
    log(`${sig}: stopping`);
    stop.abort();
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  const worker = `${hostname()}-${process.pid}`;
  const handlers = makeHandlers({ db: pool, log });
  log(`worker ${worker} up: ${Object.keys(handlers).join(", ")}; ${concurrency} at once`);

  await Promise.all([
    jobLoop({ rpc: pgRpc(pool), worker, handlers, concurrency, idleMs: 1000, drainMs: 25_000, signal: stop.signal, log }),
    tickLoop({ db: pool, signal: stop.signal, log }),
  ]);
  await pool.end().catch(() => undefined);
  log("stopped");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
