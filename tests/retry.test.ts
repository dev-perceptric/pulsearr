import assert from "node:assert/strict";
import { test } from "node:test";
import { backoffMs, fetchWithRetry, HttpStatusError, isHiccup, retryAfterMs, retryResult, splitBatch, withRetry } from "../src/lib/retry.ts";

const fast = { baseMs: 1, maxMs: 4 };

test("hiccups and real errors are told apart", () => {
  const hiccups: unknown[] = [
    new TypeError("fetch failed"),
    Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    new DOMException("The operation timed out.", "TimeoutError"),
    new DOMException("This operation was aborted: timed out", "AbortError"),
    { status: 503 },
    { status: 529, message: "overloaded_error" },
    { status: 429 },
    { code: "40001", message: "could not serialize access" },
    { code: "40P01", message: "deadlock detected" },
    { code: "57014", message: "canceling statement due to statement timeout" },
    { code: "08006", message: "connection failure" },
    new Error("Connection terminated unexpectedly"),
    new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "UND_ERR_SOCKET" }) }),
    new Response("", { status: 502 }),
  ];
  for (const e of hiccups) assert.equal(isHiccup(e), true, JSON.stringify(e) + String(e));
  const real: unknown[] = [
    new Error("bad input"),
    new DOMException("The user aborted a request.", "AbortError"),
    { status: 400 },
    { status: 401, message: "timeout in the text doesn't matter with a status" },
    { code: "23505", message: "duplicate key value violates unique constraint" },
    { code: "PGRST202", message: "Could not find the function" },
    null,
    undefined,
  ];
  for (const e of real) assert.equal(isHiccup(e), false, String(e));
});

test("Retry-After is read in seconds, ms, or as a date", () => {
  assert.equal(retryAfterMs({ headers: new Headers({ "retry-after": "2" }) }), 2000);
  assert.equal(retryAfterMs({ headers: { "Retry-After-Ms": "150" } }), 150);
  const now = Date.parse("2026-11-11T10:00:00Z");
  assert.equal(retryAfterMs({ headers: new Headers({ "retry-after": "Wed, 11 Nov 2026 10:00:05 GMT" }) }, now), 5000);
  assert.equal(retryAfterMs(new Error("x")), null);
});

test("backoff grows, stays under the cap, and is jittered", () => {
  for (let i = 0; i < 50; i++) {
    const w = backoffMs(3, 300, 8000);
    assert.ok(w >= 1200 && w <= 2400, String(w));
    assert.ok(backoffMs(20, 300, 8000) <= 8000);
  }
});

test("a call that fails twice with a hiccup then works is tried until it works", async () => {
  let calls = 0;
  const waits: number[] = [];
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed");
      return "ok";
    },
    { ...fast, onRetry: (_e, _a, ms) => waits.push(ms) },
  );
  assert.equal(out, "ok");
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
});

test("a real error is thrown at once, never repeated", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new Error("That email doesn't look right.");
    }, fast),
    /email/,
  );
  assert.equal(calls, 1);
});

test("hiccups stop after the last try, with the last error", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw Object.assign(new Error(`busy ${calls}`), { status: 503 });
    }, { ...fast, tries: 3 }),
    /busy 3/,
  );
  assert.equal(calls, 3);
});

test("a 429 waits as long as Retry-After asks", async () => {
  let calls = 0;
  const waits: number[] = [];
  const started = Date.now();
  const out = await withRetry(
    async () => {
      if (++calls === 1) throw new HttpStatusError(429, new Headers({ "retry-after": "1" }));
      return calls;
    },
    { ...fast, onRetry: (_e, _a, ms) => waits.push(ms) },
  );
  assert.equal(out, 2);
  assert.ok(waits[0]! >= 1000 && waits[0]! <= 1100, String(waits[0]));
  assert.ok(Date.now() - started >= 990);
});

test("a Retry-After longer than we wait in place is thrown, so a job can wait instead", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new HttpStatusError(429, new Headers({ "retry-after": "120" }));
    }, fast),
    (e: unknown) => e instanceof HttpStatusError && retryAfterMs(e) === 120_000,
  );
  assert.equal(calls, 1);
});

test("an abort stops the waiting", async () => {
  const ac = new AbortController();
  const p = withRetry(async () => {
    throw new TypeError("fetch failed");
  }, { baseMs: 10_000, maxMs: 10_000, signal: ac.signal });
  setTimeout(() => ac.abort(new Error("stopped")), 10);
  await assert.rejects(p, /stopped/);
});

test("retryResult tries a { error } answer again after a hiccup and returns the last answer", async () => {
  let calls = 0;
  const answer = await retryResult(async () => (++calls < 3 ? { data: null, error: { message: "fetch failed" } } : { data: 7, error: null }), fast);
  assert.deepEqual(answer, { data: 7, error: null });
  calls = 0;
  const refused = await retryResult(async () => (calls++, { data: null, error: { message: "permission denied", code: "42501" } }), fast);
  assert.equal(calls, 1);
  assert.equal(refused.error?.code, "42501");
  calls = 0;
  const busy = await retryResult(async () => (calls++, { data: null, error: { message: "timeout" } }), { ...fast, tries: 3 });
  assert.equal(calls, 3);
  assert.equal(busy.error?.message, "timeout");
  calls = 0;
  const gateway = await retryResult(async () => (++calls < 2 ? { data: null, error: { message: "<html>" }, status: 502 } : { data: 1, error: null, status: 200 }), fast);
  assert.equal(gateway.data, 1);
  assert.equal(calls, 2);
});

test("fetchWithRetry tries network failures and 5xx again, and returns the answer", async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    if (calls === 2) return new Response("busy", { status: 503 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const res = await fetchWithRetry("https://example.test/x", {}, { ...fast, fetch: fake });
  assert.equal(res.status, 200);
  assert.equal(calls, 3);
});

test("fetchWithRetry returns a 4xx at once and the last busy answer when tries run out", async () => {
  let calls = 0;
  const bad = (async () => (calls++, new Response("no", { status: 422 }))) as typeof fetch;
  assert.equal((await fetchWithRetry("https://example.test/x", {}, { ...fast, fetch: bad })).status, 422);
  assert.equal(calls, 1);
  calls = 0;
  const busy = (async () => (calls++, new Response("busy", { status: 500 }))) as typeof fetch;
  assert.equal((await fetchWithRetry("https://example.test/x", {}, { ...fast, tries: 3, fetch: busy })).status, 500);
  assert.equal(calls, 3);
});

test("fetchWithRetry gives each attempt its own timeout", async () => {
  let calls = 0;
  const slowThenFast = ((_url: string, init: RequestInit) => {
    calls++;
    if (calls === 2) return Promise.resolve(new Response("ok"));
    return new Promise<Response>((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
  }) as unknown as typeof fetch;
  // AbortSignal.timeout's timer doesn't hold the process open, and a fake fetch has no socket that would.
  const keepAlive = setInterval(() => {}, 1000);
  const res = await fetchWithRetry("https://example.test/x", {}, { ...fast, timeoutMs: 20, fetch: slowThenFast }).finally(() => clearInterval(keepAlive));
  assert.equal(await res.text(), "ok");
  assert.equal(calls, 2);
});

test("splitBatch isolates the one bad item among 9", async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const seen: number[][] = [];
  const out = await splitBatch(items, async (batch) => {
    seen.push(batch);
    if (batch.includes(5)) throw new Error("row 5 is bad");
  });
  assert.deepEqual(out.ok, [1, 2, 3, 4, 6, 7, 8, 9]);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0]!.item, 5);
  assert.match(String(out.failed[0]!.error), /row 5/);
  assert.ok(seen.length <= 9, `took ${seen.length} calls`);
});

test("splitBatch runs in batches of `size` and keeps going after a whole batch fails", async () => {
  const out = await splitBatch(["a", "b", "c", "d", "e"], async (batch) => {
    if (batch.some((x) => x === "a" || x === "b")) throw new Error("bad");
  }, { size: 2 });
  assert.deepEqual(out.ok, ["c", "d", "e"]);
  assert.deepEqual(out.failed.map((f) => f.item), ["a", "b"]);
  assert.deepEqual(await splitBatch([], async () => {}), { ok: [], failed: [] });
});
