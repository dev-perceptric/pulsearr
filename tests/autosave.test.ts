import { test } from "node:test";
import assert from "node:assert/strict";
import { autosave } from "../src/lib/autosave.ts";

// A hand-run timer: tick() fires whatever is due.
function clock() {
  let now = 0;
  let jobs: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    timers: { set: (fn: () => void, ms: number) => (jobs.push({ at: now + ms, fn, id: next }), next++), clear: (h: unknown) => void (jobs = jobs.filter((j) => j.id !== h)) },
    tick(ms: number) {
      now += ms;
      const due = jobs.filter((j) => j.at <= now);
      jobs = jobs.filter((j) => j.at > now);
      for (const j of due) j.fn();
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
/** A save the test finishes by hand. */
function gate<T>() {
  const calls: { value: T; done: (r?: unknown) => void; fail: (e: Error) => void }[] = [];
  return { calls, save: (value: T) => new Promise<unknown>((done, fail) => calls.push({ value, done, fail })) };
}

test("autosave waits for typing to stop, then saves the newest text once", async () => {
  const c = clock();
  const saved: string[] = [];
  const a = autosave<string>({ save: async (v) => void saved.push(v), timers: c.timers });
  a.change("H");
  c.tick(500);
  a.change("Hi");
  c.tick(500);
  assert.deepEqual(saved, []);
  assert.equal(a.state().status, "pending");
  c.tick(300);
  await settle();
  assert.deepEqual(saved, ["Hi"]);
  assert.equal(a.state().status, "saved");
});

test("autosave flushes at once on blur and does nothing when nothing changed", async () => {
  const c = clock();
  const saved: string[] = [];
  const a = autosave<string>({ save: async (v) => void saved.push(v), timers: c.timers });
  await a.flush();
  assert.deepEqual(saved, []);
  a.change("Hello");
  await a.flush();
  assert.deepEqual(saved, ["Hello"]);
  c.tick(1000);
  await settle();
  await a.flush();
  assert.deepEqual(saved, ["Hello"], "the timer and a second flush saved again");
});

test("autosave runs one save at a time and the latest text wins", async () => {
  const c = clock();
  const g = gate<string>();
  const a = autosave<string>({ save: g.save, timers: c.timers });
  a.change("one");
  void a.flush();
  await settle();
  a.change("two");
  void a.flush();
  a.change("three");
  const done = a.flush();
  await settle();
  assert.equal(g.calls.length, 1, "a second save started while one was running");
  g.calls[0]!.done();
  await settle();
  assert.deepEqual(g.calls.map((x) => x.value), ["one", "three"]);
  g.calls[1]!.done();
  await done;
  assert.equal(g.calls.length, 2);
  assert.equal(a.state().status, "saved");
});

test("autosave never hands back an answer for older text", async () => {
  const c = clock();
  const g = gate<string>();
  const answers: unknown[] = [];
  const a = autosave<string>({ save: g.save, onSaved: (r) => answers.push(r), timers: c.timers });
  a.change("old");
  void a.flush();
  await settle();
  a.change("new, still typing");
  g.calls[0]!.done("server copy of old");
  await settle();
  assert.deepEqual(answers, [], "an older answer was handed back");
  await Promise.all([a.flush(), settle().then(() => g.calls[1]!.done("server copy of new"))]);
  assert.deepEqual(answers, ["server copy of new"]);
});

test("autosave keeps invalid text unsaved with its error, and retries a failed save on the next change", async () => {
  const c = clock();
  let fail = true;
  const saved: string[] = [];
  const a = autosave<string>({
    save: async (v) => {
      if (fail) throw new Error("Network error");
      saved.push(v);
    },
    check: (v) => (v.trim() ? null : "The message is empty."),
    timers: c.timers,
  });
  a.change("   ");
  assert.deepEqual(a.state(), { status: "error", error: "The message is empty." });
  await a.flush();
  assert.deepEqual(saved, []);
  a.change("Hi");
  await a.flush();
  assert.deepEqual(a.state(), { status: "error", error: "Network error" });
  fail = false;
  a.change("Hi there");
  c.tick(800);
  await settle();
  assert.deepEqual(saved, ["Hi there"]);
  assert.equal(a.state().status, "saved");
});

test("a failed save is tried again on flush even with no new typing", async () => {
  let fail = true;
  const saved: string[] = [];
  const a = autosave<string>({ save: async (v) => (fail ? Promise.reject(new Error("Down")) : void saved.push(v)), timers: clock().timers });
  a.change("Hi");
  await a.flush();
  fail = false;
  await a.flush();
  assert.deepEqual(saved, ["Hi"]);
});
