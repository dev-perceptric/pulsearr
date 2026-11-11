import assert from "node:assert/strict";
import { test } from "node:test";
import { EmailError, type Email, type SendResult } from "../src/lib/email.ts";
import { JobError, runJob, type Job, type Rpc } from "../src/lib/jobs.ts";
import { makeHandlers } from "../worker/handlers.ts";
import { pgRpc, rpcSql, type Db } from "../worker/pg.ts";
import { tickOnce } from "../worker/tick.ts";

const INVITE = "22222222-2222-4222-8222-222222222222";
const job = (payload: Record<string, unknown> = { invite_id: INVITE }): Job => ({ id: "j1", workspace_id: "w", kind: "email.invite", key: INVITE, payload, attempts: 1, max_attempts: 5 });
const signal = new AbortController().signal;

function fakeDb(rows: Record<string, unknown>[]) {
  const queries: { text: string; params?: unknown[] }[] = [];
  const db: Db = {
    query: async <R>(text: string, params?: unknown[]) => {
      queries.push({ text, params });
      return { rows: rows as R[] };
    },
  };
  return { db, queries };
}

function fakeSend(answer: (e: Email) => SendResult | Error = () => ({ id: "em_1" })) {
  const sent: Email[] = [];
  const send = async (e: Email) => {
    sent.push(e);
    const a = answer(e);
    if (a instanceof Error) throw a;
    return a;
  };
  return { send, sent };
}

test("email.invite sends the invite once, keyed by the invite id", async () => {
  const { db, queries } = fakeDb([{ id: INVITE, email: "ada@example.com", workspace_name: "Acme", inviter_email: "lin@acme.com" }]);
  const { send, sent } = fakeSend();
  await makeHandlers({ db, send, appUrl: "https://app.pulsearr.com" })["email.invite"]!(job(), signal);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, "ada@example.com");
  assert.equal(sent[0]!.idempotencyKey, INVITE);
  assert.equal(sent[0]!.subject, "Join Acme on PulseARR");
  assert.ok(sent[0]!.text.includes("lin@acme.com invited you"));
  assert.ok(sent[0]!.html.includes("https://app.pulsearr.com/signin"));
  assert.deepEqual(queries[0]!.params, [INVITE]);
  assert.match(queries[0]!.text, /from public\.invites i\s+join public\.workspaces w/);
});

test("email.invite for an invite that's gone finishes without sending", async () => {
  const { db } = fakeDb([]);
  const { send, sent } = fakeSend();
  await makeHandlers({ db, send })["email.invite"]!(job(), signal);
  assert.equal(sent.length, 0);
});

test("a refused address stops retrying; a busy Resend goes back to the queue", async () => {
  const { db } = fakeDb([{ id: INVITE, email: "bad", workspace_name: "Acme", inviter_email: null }]);
  const refused = fakeSend(() => new EmailError("Resend answered 422: Invalid `to` field", 422, false));
  await assert.rejects(makeHandlers({ db, send: refused.send })["email.invite"]!(job(), signal), (e: unknown) => e instanceof JobError && !e.retry);
  const busy = fakeSend(() => new EmailError("Resend answered 503", 503, true));
  await assert.rejects(makeHandlers({ db, send: busy.send })["email.invite"]!(job(), signal), (e: unknown) => e instanceof EmailError && !(e instanceof JobError));
});

test("a bad invite_id fails without retrying or querying", async () => {
  const { db, queries } = fakeDb([]);
  await assert.rejects(makeHandlers({ db, send: fakeSend().send })["email.invite"]!(job({ invite_id: "x';drop" }), signal), (e: unknown) => e instanceof JobError && !e.retry);
  assert.equal(queries.length, 0);
});

test("the whole job runs through the queue over the pg adapter", async () => {
  const calls: { text: string; params?: unknown[] }[] = [];
  const db: Db = {
    query: async <R>(text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (text.includes("finish_job")) return { rows: [{ finish_job: true }] as R[], fields: [{ name: "finish_job" }] };
      return { rows: [{ id: INVITE, email: "ada@example.com", workspace_name: "Acme", inviter_email: null }] as R[] };
    },
  };
  const { send, sent } = fakeSend();
  const result = await runJob(pgRpc(db), "w1", job(), makeHandlers({ db, send })["email.invite"], 300);
  assert.equal(result, "done");
  assert.equal(sent.length, 1);
  const finish = calls.find((c) => c.text.includes("finish_job"))!;
  assert.equal(finish.text, "select * from public.finish_job(p_id => $1, p_worker => $2, p_ok => $3, p_error => $4, p_retry_s => $5)");
  assert.deepEqual(finish.params, ["j1", "w1", true, null, null]);
});

test("rpcSql uses named arguments, sends objects as JSON and refuses odd names", () => {
  assert.deepEqual(rpcSql("enqueue_job", { p_workspace: null, p_kind: "email.invite", p_payload: { invite_id: "x" }, p_kinds: ["a", "b"], p_skip: undefined }), {
    text: "select * from public.enqueue_job(p_workspace => $1, p_kind => $2, p_payload => $3, p_kinds => $4)",
    values: [null, "email.invite", '{"invite_id":"x"}', ["a", "b"]],
  });
  assert.throws(() => rpcSql("x; drop table jobs", {}));
  assert.throws(() => rpcSql("finish_job", { "p_id) or 1=1 --": 1 }));
});

test("pgRpc answers one value for a scalar function, rows for a set, and errors as { error }", async () => {
  const answers: Record<string, { rows: Record<string, unknown>[]; fields: { name: string }[] }> = {
    extend_job: { rows: [{ extend_job: false }], fields: [{ name: "extend_job" }] },
    claim_job: { rows: [], fields: [{ name: "id" }, { name: "kind" }] },
  };
  const db: Db = {
    query: async <R>(text: string) => {
      const fn = /public\.(\w+)\(/.exec(text)![1]!;
      if (fn === "boom") throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      return answers[fn] as unknown as { rows: R[]; fields: { name: string }[] };
    },
  };
  const rpc: Rpc = pgRpc(db);
  assert.deepEqual(await rpc("extend_job", { p_id: "j1" }), { data: false, error: null });
  assert.deepEqual(await rpc("claim_job", { p_kinds: ["email.invite"] }), { data: [], error: null });
  assert.deepEqual(await rpc("boom", {}), { data: null, error: { message: "deadlock detected", code: "40P01" } });
});

test("the tick prunes old jobs and logs the queue only when there's something to say", async () => {
  const logs: string[] = [];
  const db: Db = {
    query: async <R>(text: string) => {
      if (text.includes("prune_jobs")) return { rows: [{ n: 3 }] as R[] };
      return { rows: [{ status: "queued", n: "2" }] as R[] };
    },
  };
  assert.deepEqual(await tickOnce(db, (m) => logs.push(m)), { pruned: 3, counts: { queued: 2 } });
  assert.deepEqual(logs, ["tick: pruned 3, queued 2, running 0"]);
  const quiet: Db = { query: async <R>(text: string) => ({ rows: (text.includes("prune_jobs") ? [{ n: 0 }] : []) as R[] }) };
  logs.length = 0;
  await tickOnce(quiet, (m) => logs.push(m));
  assert.deepEqual(logs, []);
});
