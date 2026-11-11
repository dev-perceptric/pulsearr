// The one way PulseARR calls Claude. Every call goes through the step cache (ai_cache): the same workspace, model,
// system prompt and messages (or the same cacheKey) replay the stored answer and never call the model. A new call
// first takes one from the workspace's daily allowance (use_ai), marks the system prompt for prompt caching, and
// is tried again on 429, 5xx and "overloaded". Nothing calls it in M0.

import { createHash } from "node:crypto";
import type { Message, MessageCreateParamsNonStreaming, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { anthropicApiKey, envVar } from "./env.ts";
import { withRetry, type RetryOptions } from "./retry.ts";

/** Quick, cheap jobs (sorting, short summaries). */
export const FAST = envVar("AI_MODEL_FAST") || "claude-haiku-5-5";
/** Answers people read (explanations, briefs). */
export const SMART = envVar("AI_MODEL_SMART") || "claude-sonnet-5-5";

export type AiAnswer = {
  text: string;
  model: string;
  stopReason: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  /** True when it came from the step cache. */
  cached: boolean;
};

/** Where the step cache and the daily allowance live. `supabaseAiDb` is the real one; tests pass a fake. */
export type AiDb = {
  getCache(key: string): Promise<Omit<AiAnswer, "cached"> | null>;
  putCache(key: string, model: string, answer: Omit<AiAnswer, "cached">): Promise<void>;
  /** Take one call from today's allowance for this kind. False when it's used up. */
  useAi(ws: string, kind: string, limit: number): Promise<boolean>;
};

/** Just what askClaude needs from the Anthropic client, so tests can pass a fake. */
export type ClaudeClient = { messages: { create(body: MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }): PromiseLike<Message> } };

/** The workspace's daily allowance for this kind of call is used up. The message is safe to show. */
export class AiLimitError extends Error {
  constructor(message = "Today's limit for this is reached. It resets tomorrow.") {
    super(message);
    this.name = "AiLimitError";
  }
}

let client: ClaudeClient | null = null;
async function defaultClient(): Promise<ClaudeClient> {
  if (client) return client;
  const key = anthropicApiKey();
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  // Retries are ours (withRetry), so the SDK doesn't add its own on top.
  client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 120_000 });
  return client;
}

export type AskOptions = {
  ws: string;
  /** What the call is for, like "pulse.brief". Each kind has its own daily allowance. */
  kind: string;
  model: string;
  system: string;
  messages: MessageParam[];
  maxTokens: number;
  /** Replaces the hash of the prompt as the cache key (still per workspace). */
  cacheKey?: string;
  limitPerDay?: number;
  signal?: AbortSignal;
  db: AiDb;
  client?: ClaudeClient;
  retry?: RetryOptions;
};

/** The step-cache key: one workspace, one model, one exact prompt. */
export function cacheKeyFor(o: Pick<AskOptions, "ws" | "model" | "system" | "messages" | "cacheKey">): string {
  const what = o.cacheKey !== undefined ? { ws: o.ws, model: o.model, key: o.cacheKey } : { ws: o.ws, model: o.model, system: o.system, messages: o.messages };
  return createHash("sha256").update(JSON.stringify(what)).digest("hex");
}

export async function askClaude(o: AskOptions): Promise<AiAnswer> {
  const key = cacheKeyFor(o);
  const hit = await o.db.getCache(key).catch((e) => {
    console.warn("ai_cache read failed:", e instanceof Error ? e.message : e);
    return null;
  });
  if (hit) return { ...hit, cached: true };

  if (!(await o.db.useAi(o.ws, o.kind, o.limitPerDay ?? 500))) throw new AiLimitError();

  const claude = o.client ?? (await defaultClient());
  const body: MessageCreateParamsNonStreaming = {
    model: o.model,
    max_tokens: o.maxTokens,
    system: [{ type: "text", text: o.system, cache_control: { type: "ephemeral" } }],
    messages: o.messages,
  };
  const msg = await withRetry(() => Promise.resolve(claude.messages.create(body, { signal: o.signal })), { tries: 4, baseMs: 1000, maxMs: 20_000, signal: o.signal, ...o.retry });
  const answer: Omit<AiAnswer, "cached"> = {
    text: msg.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join(""),
    model: msg.model,
    stopReason: msg.stop_reason ?? null,
    usage: {
      input_tokens: msg.usage.input_tokens,
      output_tokens: msg.usage.output_tokens,
      cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? null,
    },
  };
  // Only a finished answer is replayed. One cut off at max_tokens or refused would be wrong every time after.
  if (answer.stopReason === "end_turn" || answer.stopReason === "stop_sequence") {
    await o.db.putCache(key, o.model, answer).catch((e) => console.warn("ai_cache write failed:", e instanceof Error ? e.message : e));
  }
  return { ...answer, cached: false };
}

/** The minimal Supabase client shape the step cache uses (the service-role client). */
type SupaLike = {
  from(table: string): {
    select(cols: string): { eq(col: string, v: string): { maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }> } };
    upsert(row: object, opts?: { onConflict?: string }): PromiseLike<{ error: { message: string } | null }>;
    update(row: object): { eq(col: string, v: string): PromiseLike<{ error: { message: string } | null }> };
  };
  rpc(fn: string, args: object): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/** The step cache and allowance over a service-role Supabase client: table ai_cache and function use_ai. */
export function supabaseAiDb(sb: SupaLike): AiDb {
  return {
    async getCache(key) {
      const { data, error } = await sb.from("ai_cache").select("response, hits").eq("key", key).maybeSingle();
      if (error) throw new Error(error.message);
      const row = data as { response: Omit<AiAnswer, "cached">; hits: number | null } | null;
      if (!row?.response) return null;
      void Promise.resolve(sb.from("ai_cache").update({ last_used_at: new Date().toISOString(), hits: (row.hits ?? 0) + 1 }).eq("key", key)).catch(() => undefined);
      return row.response;
    },
    async putCache(key, model, answer) {
      const { error } = await sb.from("ai_cache").upsert({ key, model, response: answer, last_used_at: new Date().toISOString() }, { onConflict: "key" });
      if (error) throw new Error(error.message);
    },
    async useAi(ws, kind, limit) {
      const { data, error } = await sb.rpc("use_ai", { p_ws: ws, p_kind: kind, p_limit: limit });
      if (error) throw new Error(`use_ai: ${error.message}`);
      return data === true;
    },
  };
}
