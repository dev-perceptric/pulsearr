// The Stripe API over fetch, for the web app and the worker (Node runs this file directly). Every call carries the
// pinned Stripe-Version the engine and the fixtures were written against, and goes through src/lib/retry.ts: a 429,
// a 5xx or a network drop waits and tries again; anything else comes back at once as a StripeError.
//
//   stripeClient({ auth, fetch?, signal?, retry? })
//     get(path, params)    GET with params in the query (expand[], created[gte], starting_after ...)
//     post(path, params)   POST with a form body. Only for calls that are safe to send twice.
//     listAll(path, params, max?)  every page of a list (starting_after), for short lists (items, lines, refunds)
//
// `auth` is a key or token (string), or { token, refresh } for Stripe App sources: token() gives the current access
// token, and refresh(used) is called once when Stripe answers 401, to roll the tokens and give the new one.

import { HttpStatusError, fetchWithRetry, type RetryOptions } from "../retry.ts";

export const STRIPE_API = "https://api.stripe.com";
/** The API version every call pins. The fixtures in tests/fixtures/stripe are in this shape. */
export const STRIPE_VERSION = "2024-06-20";
/** The most a list page holds. */
export const PAGE_LIMIT = 100;

type Obj = Record<string, unknown>;
export type StripeObject = Obj & { id?: string; object?: string };
export type StripeList<T = StripeObject> = { object: "list"; data: T[]; has_more: boolean; url?: string };

export type Params = Record<string, unknown>;

/** An answer from Stripe that wasn't ok, with Stripe's error fields. */
export class StripeError extends Error {
  status: number;
  type: string | null;
  code: string | null;
  param: string | null;
  requestId: string | null;
  headers: Headers;
  constructor(status: number, body: unknown, headers: Headers = new Headers()) {
    const err = (body && typeof body === "object" ? (body as Obj).error : null) as Obj | null;
    const message = typeof err?.message === "string" ? err.message : typeof (body as Obj | null)?.error_description === "string" ? String((body as Obj).error_description) : `Stripe answered ${status}`;
    super(message);
    this.name = "StripeError";
    this.status = status;
    this.type = typeof err?.type === "string" ? err.type : typeof (body as Obj | null)?.error === "string" ? String((body as Obj).error) : null;
    this.code = typeof err?.code === "string" ? err.code : null;
    this.param = typeof err?.param === "string" ? err.param : null;
    this.requestId = headers.get("request-id");
    this.headers = headers;
  }
  /** The object isn't there (deleted, or never was). */
  get missing() {
    return this.status === 404 || this.code === "resource_missing";
  }
}

/**
 * Stripe's form encoding: nested objects as key[sub]=v, arrays as key[]=v, null and undefined left out. Keys are
 * sorted so the same params always give the same string.
 */
export function encodeParams(params: Params = {}): string {
  const out: string[] = [];
  const add = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      for (const x of v) add(`${key}[]`, x);
      return;
    }
    if (typeof v === "object") {
      for (const k of Object.keys(v as Obj).sort()) add(`${key}[${k}]`, (v as Obj)[k]);
      return;
    }
    out.push(`${encodeURIComponent(key).replace(/%5B/g, "[").replace(/%5D/g, "]")}=${encodeURIComponent(String(v))}`);
  };
  for (const k of Object.keys(params).sort()) add(k, params[k]);
  return out.join("&");
}

export type StripeAuth = string | { token: () => Promise<string>; refresh?: (used: string) => Promise<string> };

export type StripeClientOptions = {
  auth: StripeAuth;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Retry settings for hiccups. Tests shrink the waits. */
  retry?: RetryOptions;
  timeoutMs?: number;
  base?: string;
};

export type StripeClient = {
  get<T = StripeObject>(path: string, params?: Params): Promise<T>;
  post<T = StripeObject>(path: string, params?: Params): Promise<T>;
  listAll<T extends StripeObject = StripeObject>(path: string, params?: Params, max?: number): Promise<T[]>;
};

const DEFAULT_RETRY: RetryOptions = { tries: 5, baseMs: 500, maxMs: 8000, maxRetryAfterMs: 30_000 };

export async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 300) } };
  }
}

export function stripeClient(o: StripeClientOptions): StripeClient {
  const base = (o.base ?? STRIPE_API).replace(/\/+$/, "");
  const auth = typeof o.auth === "string" ? { token: async () => o.auth as string } : o.auth;
  const retry = { ...DEFAULT_RETRY, ...o.retry, signal: o.signal };

  const once = async (method: "GET" | "POST", path: string, params: Params | undefined, token: string) => {
    const query = encodeParams(params);
    const url = method === "GET" && query ? `${base}${path}?${query}` : `${base}${path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Stripe-Version": STRIPE_VERSION };
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    return fetchWithRetry(url, { method, headers, body: method === "POST" ? query : undefined }, { ...retry, fetch: o.fetch, timeoutMs: o.timeoutMs ?? 20_000 });
  };

  const request = async <T>(method: "GET" | "POST", path: string, params?: Params): Promise<T> => {
    if (!path.startsWith("/v1/")) throw new Error(`Stripe path must start with /v1/: ${path}`);
    let token = await auth.token();
    let res: Response;
    try {
      res = await once(method, path, params, token);
      if (res.status === 401 && auth.refresh) {
        await res.body?.cancel().catch(() => undefined);
        token = await auth.refresh(token);
        res = await once(method, path, params, token);
      }
    } catch (e) {
      // A busy answer that never cleared: Stripe's status, so the caller can wait (429) or retry later (5xx).
      if (e instanceof HttpStatusError) throw new StripeError(e.status, safeJson(e.body), e.headers);
      throw e;
    }
    const body = await readBody(res);
    if (!res.ok) throw new StripeError(res.status, body, res.headers);
    return body as T;
  };

  return {
    get: (path, params) => request("GET", path, params),
    post: (path, params) => request("POST", path, params),
    async listAll<T extends StripeObject>(path: string, params: Params = {}, max = 10_000): Promise<T[]> {
      const all: T[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await request<StripeList<T>>("GET", path, { limit: PAGE_LIMIT, ...params, starting_after: after });
        all.push(...page.data);
        const last = page.data.at(-1)?.id;
        if (!page.has_more || !last || all.length >= max) return all;
        after = last;
      }
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** True when the error is Stripe asking us to slow down. */
export const isRateLimited = (e: unknown) => e instanceof StripeError && e.status === 429;
