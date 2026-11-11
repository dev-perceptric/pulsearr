import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { enqueueJob, failureArgs, JobError, jobLoop, runJob, type Job, type Rpc } from "../src/lib/jobs.ts";

const job = (over: Partial<Job> = {}): Job => ({ id: "j1", workspace_id: "w", kind: "email.invite", key: "k1", payload: {}, attempts: 1, max_attempts: 5, ...over });

function fakeRpc(answers: Record<string, unknown> = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args });
    const a = answers[fn];
    const v = typeof a === "function" ? (a as (args: Record<string, unknown>) => unknown)(args) : (a ?? true);
    if (v instanceof Error) return { data: null, error: { message: v.message, code: (v as { code?: string }).code } };
    return { data: v, error: null };
  };
  return { rpc, calls };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("a job that works is finished as done", async () => {
  const { rpc, calls } = fakeRpc();
  assert.equal(await runJob(rpc, "w1", job(), async () => {}), "done");
  assert.deepEqual(calls.at(-1), { fn: "finish_job", args: { p_id: "j1", p_worker: "w1", p_ok: true, p_error: null, p_retry_s: null } });
});

test("a job that throws is finished as failed, retried by the database's schedule", async () => {
  const { rpc, calls } = fakeRpc();
  assert.equal(await runJob(rpc, "w1", job(), async () => { throw new Error("Resend said 503"); }), "failed");
  assert.equal(calls.at(-1)!.args.p_error, "Resend said 503");
  assert.equal(calls.at(-1)!.args.p_retry_s, null);
  assert.ok(!("p_wait_s" in calls.at(-1)!.args), "p_wait_s is only sent when a handler asks to wait");
});

test("JobError can stop retries, set the wait, or wait without using an attempt", async () => {
  const { rpc, calls } = fakeRpc();
  await runJob(rpc, "w1", job(), async () => { throw new JobError("bad input", { retry: false }); });
  assert.equal(calls.at(-1)!.args.p_retry_s, -1);
  await runJob(rpc, "w1", job(), async () => { throw new JobError("rate limited", { retryAfterS: 30 }); });
  assert.equal(calls.at(-1)!.args.p_retry_s, 30);
  assert.equal(await runJob(rpc, "w1", job(), async () => { throw new JobError("Stripe asked us to wait", { waitS: 60 }); }), "waiting");
  assert.equal(calls.at(-1)!.args.p_wait_s, 60);
  assert.equal(calls.at(-1)!.args.p_retry_s, null);
  assert.deepEqual(failureArgs(new JobError("x", { waitS: 0.2 })).p_wait_s, 1);
});

test("a kind with no handler fails without retrying", async () => {
  const { rpc, calls } = fakeRpc();
  assert.equal(await runJob(rpc, "w1", job({ kind: "unknown" }), undefined), "failed");
  assert.equal(calls.at(-1)!.args.p_retry_s, -1);
});

test("a lost lease aborts the handler and is reported", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const { rpc, calls } = fakeRpc({ extend_job: false });
    let aborted = false;
    const result = runJob(rpc, "w1", job(), (_j, signal) => new Promise<void>((r) => signal.addEventListener("abort", () => ((aborted = true), r()))), 30);
    mock.timers.tick(10_000);
    assert.equal(await result, "lost");
    assert.ok(aborted, "the handler wasn't told the lease was lost");
    assert.deepEqual(calls[0], { fn: "extend_job", args: { p_id: "j1", p_worker: "w1", p_lease_s: 30 } });
    assert.ok(!calls.some((c) => c.fn === "finish_job"));
  } finally {
    mock.timers.reset();
  }
});

test("the lease is renewed every third of its length while the job runs", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const { rpc, calls } = fakeRpc({ extend_job: true });
    let finish!: () => void;
    const result = runJob(rpc, "w1", job(), () => new Promise<void>((r) => (finish = r)), 300);
    mock.timers.tick(100_000);
    mock.timers.tick(100_000);
    mock.timers.tick(99_000);
    await tick();
    assert.equal(calls.filter((c) => c.fn === "extend_job").length, 2);
    finish();
    assert.equal(await result, "done");
  } finally {
    mock.timers.reset();
  }
});

test("finishing a job is tried again when the database hiccups (flaky finish_job)", async () => {
  let n = 0;
  const { rpc, calls } = fakeRpc({ finish_job: () => (++n < 3 ? Object.assign(new Error("Connection terminated unexpectedly"), { code: "08006" }) : true) });
  assert.equal(await runJob(rpc, "w1", job(), async () => {}), "done");
  assert.equal(calls.filter((c) => c.fn === "finish_job").length, 3);
});

test("a database that never answers finish_job leaves the job to its lease, without throwing", async () => {
  const { rpc } = fakeRpc({ finish_job: () => Object.assign(new Error("permission denied for function finish_job"), { code: "42501" }) });
  assert.equal(await runJob(rpc, "w1", job(), async () => {}), "lost");
});

test("enqueueJob passes defaults", async () => {
  const { rpc, calls } = fakeRpc({ enqueue_job: "new-id" });
  assert.equal(await enqueueJob(rpc, { workspaceId: "w", kind: "email.invite", key: "inv-1", payload: { invite_id: "inv-1" } }), "new-id");
  assert.deepEqual(calls[0], {
    fn: "enqueue_job",
    args: { p_workspace: "w", p_kind: "email.invite", p_key: "inv-1", p_payload: { invite_id: "inv-1" }, p_delay_s: 0, p_max_attempts: 5 },
  });
});

test("the loop claims only the kinds it handles and runs each job", async () => {
  const ac = new AbortController();
  let claims = 0;
  const { rpc, calls } = fakeRpc({ claim_job: () => (++claims === 1 ? [job({ kind: "email.invite" })] : []) });
  const ran: string[] = [];
  const loop = jobLoop({ rpc, worker: "w1", handlers: { "email.invite": async (j) => void ran.push(j.kind) }, idleMs: 10, signal: ac.signal });
  await tick(60);
  ac.abort();
  await loop;
  assert.deepEqual(ran, ["email.invite"]);
  const claim = calls.find((c) => c.fn === "claim_job")!;
  assert.deepEqual(claim.args.p_kinds, ["email.invite"]);
  assert.equal(claim.args.p_worker, "w1");
});

test("the loop runs up to `concurrency` jobs at once and claims only what it has room for", async () => {
  const ac = new AbortController();
  let next = 0;
  const { rpc, calls } = fakeRpc({ claim_job: (a: Record<string, unknown>) => Array.from({ length: Number(a.p_limit) }, () => job({ id: `j${++next}` })) });
  let now = 0;
  let peak = 0;
  const loop = jobLoop({
    rpc,
    worker: "w1",
    concurrency: 3,
    idleMs: 5,
    signal: ac.signal,
    handlers: {
      "email.invite": async () => {
        peak = Math.max(peak, ++now);
        await tick(15);
        now--;
      },
    },
  });
  await tick(80);
  ac.abort();
  await loop;
  assert.equal(peak, 3);
  assert.ok(next > 3, "it kept claiming as jobs finished");
  assert.ok(calls.filter((c) => c.fn === "claim_job").every((c) => Number(c.args.p_limit) >= 1 && Number(c.args.p_limit) <= 3));
});

test("a failed claim backs off and the loop keeps going (flaky database)", async () => {
  const ac = new AbortController();
  let claims = 0;
  const ran: string[] = [];
  const logs: string[] = [];
  const { rpc } = fakeRpc({
    claim_job: () => {
      claims++;
      if (claims <= 2) return new Error("connect ECONNREFUSED");
      return claims === 3 ? [job({ id: "after" })] : [];
    },
  });
  const loop = jobLoop({ rpc, worker: "w1", handlers: { "email.invite": async (j) => void ran.push(j.id) }, idleMs: 2, signal: ac.signal, log: (m) => logs.push(m) });
  await tick(100);
  ac.abort();
  await loop;
  assert.deepEqual(ran, ["after"]);
  assert.equal(logs.filter((l) => l.startsWith("claim_job failed")).length, 2);
});

test("on stop, running jobs get to finish, and the loop claims nothing new", async () => {
  const ac = new AbortController();
  let claims = 0;
  const { rpc, calls } = fakeRpc({ claim_job: () => (++claims === 1 ? [job()] : []) });
  let finished = false;
  const loop = jobLoop({
    rpc,
    worker: "w1",
    idleMs: 5,
    drainMs: 1000,
    signal: ac.signal,
    handlers: { "email.invite": async () => { await tick(50); finished = true; } },
  });
  await tick(10);
  ac.abort();
  const claimsAtStop = claims;
  await loop;
  assert.ok(finished);
  assert.equal(claims, claimsAtStop);
  assert.equal(calls.find((c) => c.fn === "finish_job")!.args.p_ok, true);
});

test("a job still running after the drain time is told to stop and put back without using an attempt", async () => {
  const ac = new AbortController();
  let claims = 0;
  const { rpc, calls } = fakeRpc({ claim_job: () => (++claims === 1 ? [job()] : []) });
  const loop = jobLoop({
    rpc,
    worker: "w1",
    idleMs: 5,
    drainMs: 20,
    signal: ac.signal,
    handlers: { "email.invite": (_j, signal) => new Promise<void>((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason))) },
  });
  await tick(10);
  ac.abort();
  await loop;
  const finish = calls.find((c) => c.fn === "finish_job")!;
  assert.equal(finish.args.p_ok, false);
  assert.equal(finish.args.p_wait_s, 5);
});
