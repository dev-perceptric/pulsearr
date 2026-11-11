// The jobs queue (the jobs migration: enqueue_job, claim_job, extend_job, finish_job, prune_jobs). The web app adds
// jobs over supabase-js; the worker claims and runs them over pg (worker/main.ts), through the same `Rpc` shape.
// A worker keeps the lease while a job runs (renewed every third of its length) and the handler's signal aborts if
// the lease is lost. A handler that throws is retried by the database (1, 5, 30 minutes, then 2 and 6 hours).
// Throw JobError to say more:
//   new JobError(msg, { retry: false })     stop: the job fails now
//   new JobError(msg, { retryAfterS: 90 })  try again in 90 seconds, using an attempt
//   new JobError(msg, { waitS: 60 })        put it back for 60 seconds without using an attempt (rate limits)

import { isHiccup, sleep, withRetry } from "./retry.ts";

export type Job = {
  id: string;
  workspace_id: string | null;
  kind: string;
  key: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

/** The one call the queue needs: Supabase's `rpc`, the worker's pg adapter, or a fake in tests. */
export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

export class JobError extends Error {
  retry: boolean;
  retryAfterS?: number;
  waitS?: number;
  constructor(message: string, opts: { retry?: boolean; retryAfterS?: number; waitS?: number } = {}) {
    super(message);
    this.name = "JobError";
    this.retry = opts.retry ?? true;
    this.retryAfterS = opts.retryAfterS;
    this.waitS = opts.waitS;
  }
}

class RpcError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function call<T>(rpc: Rpc, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new RpcError(`${fn}: ${error.message}`, error.code);
  return data as T;
}

// Queue calls that must land (finishing a job) are tried again after a database hiccup.
const callHard = <T>(rpc: Rpc, fn: string, args: Record<string, unknown>) => withRetry(() => call<T>(rpc, fn, args), { tries: 5, baseMs: 500, maxMs: 8000, retryOn: isHiccup });

/** Add a job. With a key, it joins the job already waiting for that key. Returns the waiting job's id. */
export const enqueueJob = (rpc: Rpc, job: { workspaceId: string | null; kind: string; key?: string; payload?: object; delayS?: number; maxAttempts?: number }) =>
  callHard<string>(rpc, "enqueue_job", {
    p_workspace: job.workspaceId,
    p_kind: job.kind,
    p_key: job.key ?? "",
    p_payload: job.payload ?? {},
    p_delay_s: job.delayS ?? 0,
    p_max_attempts: job.maxAttempts ?? 5,
  });

export type Handler = (job: Job, signal: AbortSignal) => Promise<void>;
export type JobResult = "done" | "failed" | "waiting" | "lost";

/** What finish_job is told about a failure. p_wait_s is only sent when a handler asked to wait. */
export function failureArgs(e: unknown): { p_error: string; p_retry_s: number | null; p_wait_s?: number } {
  const err = e instanceof JobError ? e : null;
  const message = (e instanceof Error ? e.message : String(e)) || "Failed";
  if (err?.waitS !== undefined && err.retry) return { p_error: message.slice(0, 2000), p_retry_s: null, p_wait_s: Math.max(1, Math.round(err.waitS)) };
  return { p_error: message.slice(0, 2000), p_retry_s: err && !err.retry ? -1 : err?.retryAfterS !== undefined ? Math.max(1, Math.round(err.retryAfterS)) : null };
}

/**
 * Run one job: keep its lease while the handler works, then finish it. Returns what happened; never throws.
 * The signal aborts when the lease is lost (or `stop` aborts), so the handler can stop early.
 */
export async function runJob(rpc: Rpc, worker: string, job: Job, handler: Handler | undefined, leaseS = 300, stop?: AbortSignal): Promise<JobResult> {
  const ac = new AbortController();
  const onStop = () => ac.abort(stop?.reason);
  stop?.addEventListener("abort", onStop, { once: true });
  const keep = setInterval(
    () => {
      void call<boolean>(rpc, "extend_job", { p_id: job.id, p_worker: worker, p_lease_s: leaseS })
        .then((ok) => {
          if (!ok) ac.abort(new JobError("The job's lease was lost"));
        })
        .catch(() => undefined);
    },
    Math.max(5, leaseS / 3) * 1000,
  );
  try {
    let args: Record<string, unknown>;
    let outcome: JobResult;
    try {
      if (!handler) throw new JobError(`No handler for ${job.kind}`, { retry: false });
      await handler(job, ac.signal);
      args = { p_id: job.id, p_worker: worker, p_ok: true, p_error: null, p_retry_s: null };
      outcome = "done";
    } catch (e) {
      // Stopped for a shutdown: back in line soon, without using an attempt.
      const failure = failureArgs(stop?.aborted ? new JobError("The worker stopped before the job finished", { waitS: 5 }) : e);
      args = { p_id: job.id, p_worker: worker, p_ok: false, ...failure };
      outcome = failure.p_wait_s !== undefined ? "waiting" : "failed";
    }
    if (ac.signal.aborted && !stop?.aborted) return "lost";
    try {
      const ok = await callHard<boolean>(rpc, "finish_job", args);
      return ok ? outcome : "lost";
    } catch {
      // The database never answered: the lease runs out and claim_job puts the job back.
      return "lost";
    }
  } finally {
    clearInterval(keep);
    stop?.removeEventListener("abort", onStop);
  }
}

export type LoopOptions = {
  rpc: Rpc;
  worker: string;
  handlers: Record<string, Handler>;
  leaseS?: number;
  /** Jobs running at once. */
  concurrency?: number;
  idleMs?: number;
  /** Stop claiming when this aborts; jobs already running get `drainMs` to finish. */
  signal?: AbortSignal;
  drainMs?: number;
  log?: (msg: string) => void;
};

/**
 * Claim and run jobs until `signal` aborts, up to `concurrency` at once. Waits `idleMs` when there's nothing to do,
 * and longer after each failed claim (the database is down), up to 30 seconds. After the signal, waits up to
 * `drainMs` for running jobs, then tells the rest to stop and returns; a job still running then is put back by
 * the database when its lease runs out.
 */
export async function jobLoop(o: LoopOptions): Promise<void> {
  const kinds = Object.keys(o.handlers);
  const leaseS = o.leaseS ?? 300;
  const max = Math.max(1, o.concurrency ?? 1);
  const running = new Set<Promise<void>>();
  const stopJobs = new AbortController();
  let failures = 0;
  let wake: (() => void) | null = null;
  // Rest for `ms`, or less: a finished job or the stop signal wakes the loop. Leaves no timer behind.
  const nap = async (ms: number) => {
    const ac = new AbortController();
    const onStop = () => ac.abort();
    wake = onStop;
    o.signal?.addEventListener("abort", onStop, { once: true });
    await sleep(ms, ac.signal).catch(() => undefined);
    o.signal?.removeEventListener("abort", onStop);
    wake = null;
  };

  while (!o.signal?.aborted) {
    if (running.size >= max) {
      await nap(60_000);
      continue;
    }
    let jobs: Job[] = [];
    try {
      jobs = (await call<Job[] | null>(o.rpc, "claim_job", { p_kinds: kinds, p_worker: o.worker, p_lease_s: leaseS, p_limit: max - running.size })) ?? [];
      failures = 0;
    } catch (e) {
      failures++;
      o.log?.(`claim_job failed: ${e instanceof Error ? e.message : String(e)}`);
      await nap(Math.min(30_000, (o.idleMs ?? 1000) * 2 ** failures));
      continue;
    }
    for (const job of jobs) {
      const p: Promise<void> = runJob(o.rpc, o.worker, job, o.handlers[job.kind], leaseS, stopJobs.signal)
        .then((result) => {
          if (result !== "done") o.log?.(`${job.kind} ${job.id}: ${result}`);
        })
        .finally(() => {
          running.delete(p);
          wake?.();
        });
      running.add(p);
    }
    // A full claim may mean more are waiting, so claim again at once. Otherwise rest until a job finishes.
    if (jobs.length === 0) await nap(o.idleMs ?? 1000);
  }

  if (running.size) {
    o.log?.(`stopping: waiting for ${running.size} running job(s)`);
    if (!(await within(Promise.all(running), o.drainMs ?? 25_000))) {
      o.log?.(`stopping: ${running.size} job(s) still running, telling them to stop`);
      stopJobs.abort(new JobError("The worker is stopping"));
      await within(Promise.all(running), 2000);
    }
  }
}

/** True when `p` settles within `ms`. Leaves no timer behind. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  const ac = new AbortController();
  try {
    return await Promise.race([p.then(() => true), sleep(ms, ac.signal).then(() => false, () => false)]);
  } finally {
    ac.abort();
  }
}
