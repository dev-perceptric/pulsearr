import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { AiLimitError, askClaude, cacheKeyFor, FAST, SMART, supabaseAiDb, type AiDb, type ClaudeClient } from "../src/lib/ai.ts";

function memoryDb(allowance = 100) {
  const cache = new Map<string, unknown>();
  let used = 0;
  const db: AiDb = {
    getCache: async (key) => (cache.get(key) as Awaited<ReturnType<AiDb["getCache"]>>) ?? null,
    putCache: async (key, _model, answer) => void cache.set(key, answer),
    useAi: async () => ++used <= allowance,
  };
  return { db, cache, used: () => used };
}

function fakeClaude(answers: (() => Partial<Message> | Error)[] = [() => ({})]) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  const client: ClaudeClient = {
    messages: {
      create: async (body) => {
        calls.push(body);
        const a = answers[Math.min(calls.length - 1, answers.length - 1)]!();
        if (a instanceof Error) throw a;
        return {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: "MRR rose 4.2%.", citations: null }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 10 },
          ...a,
        } as Message;
      },
    },
  };
  return { client, calls };
}

const ask = { ws: "ws-1", kind: "pulse.test", model: FAST, system: "You explain MRR.", messages: [{ role: "user" as const, content: "Why did MRR move?" }], maxTokens: 200 };

test("model names default and can be set by env", () => {
  assert.equal(FAST, process.env.AI_MODEL_FAST?.trim() || "claude-haiku-5-5");
  assert.equal(SMART, process.env.AI_MODEL_SMART?.trim() || "claude-sonnet-5-5");
});

test("the first call asks the model with a cached system prompt; the same call again replays and never calls it", async () => {
  const { db, used } = memoryDb();
  const { client, calls } = fakeClaude();
  const first = await askClaude({ ...ask, db, client });
  assert.equal(first.text, "MRR rose 4.2%.");
  assert.equal(first.cached, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.system, [{ type: "text", text: "You explain MRR.", cache_control: { type: "ephemeral" } }]);
  assert.equal(calls[0]!.max_tokens, 200);

  const again = await askClaude({ ...ask, db, client });
  assert.equal(again.cached, true);
  assert.equal(again.text, "MRR rose 4.2%.");
  assert.equal(calls.length, 1, "a cached step must not call the model");
  assert.equal(used(), 1, "a cached step must not use the allowance");
});

test("a different prompt, model, workspace or cacheKey is a different step", () => {
  const base = cacheKeyFor(ask);
  assert.equal(base, cacheKeyFor({ ...ask }));
  assert.notEqual(base, cacheKeyFor({ ...ask, ws: "ws-2" }));
  assert.notEqual(base, cacheKeyFor({ ...ask, model: SMART }));
  assert.notEqual(base, cacheKeyFor({ ...ask, system: "Other." }));
  assert.notEqual(base, cacheKeyFor({ ...ask, messages: [{ role: "user", content: "Other" }] }));
  assert.equal(cacheKeyFor({ ...ask, cacheKey: "brief:2026-11-11" }), cacheKeyFor({ ...ask, system: "changed", cacheKey: "brief:2026-11-11" }));
  assert.match(base, /^[0-9a-f]{64}$/);
});

test("when the daily allowance is used up it throws a plain error and doesn't call the model", async () => {
  const { db } = memoryDb(0);
  const { client, calls } = fakeClaude();
  await assert.rejects(askClaude({ ...ask, db, client }), (e: unknown) => e instanceof AiLimitError && /limit/.test(e.message) && !/use_ai|sql/i.test(e.message));
  assert.equal(calls.length, 0);
});

test("an overloaded or rate-limited model is tried again (flaky model)", async () => {
  const { db } = memoryDb();
  const overloaded = Object.assign(new Error("overloaded_error"), { status: 529 });
  const limited = Object.assign(new Error("rate_limit_error"), { status: 429, headers: new Headers({ "retry-after": "0" }) });
  const { client, calls } = fakeClaude([() => overloaded, () => limited, () => ({})]);
  const out = await askClaude({ ...ask, db, client, retry: { baseMs: 1, maxMs: 4 } });
  assert.equal(out.text, "MRR rose 4.2%.");
  assert.equal(calls.length, 3);
});

test("a bad request isn't retried", async () => {
  const { db } = memoryDb();
  const { client, calls } = fakeClaude([() => Object.assign(new Error("invalid_request_error"), { status: 400 })]);
  await assert.rejects(askClaude({ ...ask, db, client, retry: { baseMs: 1, maxMs: 4 } }), /invalid_request/);
  assert.equal(calls.length, 1);
});

test("an answer cut off at max_tokens is returned but not replayed", async () => {
  const { db, cache } = memoryDb();
  const { client, calls } = fakeClaude([() => ({ stop_reason: "max_tokens" })]);
  await askClaude({ ...ask, db, client });
  assert.equal(cache.size, 0);
  await askClaude({ ...ask, db, client });
  assert.equal(calls.length, 2);
});

test("a step cache that can't be read falls through to the model", async () => {
  const { db } = memoryDb();
  db.getCache = async () => {
    throw new Error("relation ai_cache does not exist");
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { client, calls } = fakeClaude();
    assert.equal((await askClaude({ ...ask, db, client })).cached, false);
    assert.equal(calls.length, 1);
  } finally {
    console.warn = warn;
  }
});

test("supabaseAiDb uses ai_cache and use_ai", async () => {
  const seen: string[] = [];
  const row = { response: { text: "t", model: "m", stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }, hits: 2 };
  const sb = {
    from: (table: string) => ({
      select: (cols: string) => ({ eq: (c: string, v: string) => ({ maybeSingle: async () => (seen.push(`select ${table} ${cols} ${c}=${v}`), { data: row, error: null }) }) }),
      upsert: async (r: object, o?: { onConflict?: string }) => (seen.push(`upsert ${table} ${Object.keys(r).join(",")} ${o?.onConflict}`), { error: null }),
      update: (r: Record<string, unknown>) => ({ eq: async (c: string, v: string) => (seen.push(`update ${table} hits=${r.hits} ${c}=${v}`), { error: null }) }),
    }),
    rpc: async (fn: string, args: object) => (seen.push(`rpc ${fn} ${JSON.stringify(args)}`), { data: true, error: null }),
  };
  const db = supabaseAiDb(sb);
  assert.deepEqual(await db.getCache("k"), row.response);
  await db.putCache("k", "m", row.response);
  assert.equal(await db.useAi("ws", "pulse.test", 50), true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(seen.sort(), [
    "rpc use_ai {\"p_ws\":\"ws\",\"p_kind\":\"pulse.test\",\"p_limit\":50}",
    "select ai_cache response, hits key=k",
    "update ai_cache hits=3 key=k",
    "upsert ai_cache key,model,response,last_used_at key",
  ].sort());
});
