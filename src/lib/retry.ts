// The one retry helper, for the browser, the server and the worker. A hiccup (timeout, network, busy database,
// 5xx, 429) is tried again on its own with growing, jittered waits, honoring Retry-After. Anything else is thrown
// at once, so a real mistake is never repeated. splitBatch keeps one bad row from stopping the rest.

export type RetryOptions = {
  /** Attempts in all, the first one included. */
  tries?: number;
  /** The first wait. Each wait doubles, up to maxMs. */
  baseMs?: number;
  maxMs?: number;
  /** A Retry-After longer than this isn't waited for here: the error is thrown, so a job can wait instead. */
  maxRetryAfterMs?: number;
  signal?: AbortSignal;
  /** Which errors to try again. Defaults to isHiccup. */
  retryOn?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, waitMs: number) => void;
};

/** An HTTP answer that wasn't ok, as an error that carries its status and headers. */
export class HttpStatusError extends Error {
  status: number;
  headers: Headers;
  body: string;
  constructor(status: number, headers: Headers, body = "", message?: string) {
    super(message ?? `HTTP ${status}${body ? `: ${body.slice(0, 300)}` : ""}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

// Postgres: serialization failure, deadlock, statement timeout, too many connections, shutdown, cannot connect now.
const PG_CODES = new Set(["40001", "40P01", "57014", "53300", "57P01", "57P03"]);
const NET_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const HICCUP_TEXT =
  /fetch failed|failed to fetch|network ?error|load failed|timed? ?out|timeout|socket hang up|connection terminated|terminating connection|could not serialize|deadlock detected|too many (requests|connections)|rate.?limit|overloaded|temporarily unavailable|service unavailable|bad gateway|gateway timeout|\b(status|http)(?: code)? (429|50[0-9]|529)\b/i;

type Errorish = { name?: unknown; message?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };

const statusOf = (e: Errorish): number | null => {
  const s = Number(e.status ?? e.statusCode);
  return Number.isInteger(s) && s >= 100 && s < 600 ? s : null;
};

/** True when trying again could work: a timeout, a network drop, a busy database, a 5xx or a 429. */
export function isHiccup(err: unknown, depth = 0): boolean {
  if (err == null || depth > 4) return false;
  if (typeof err === "string") return HICCUP_TEXT.test(err);
  if (typeof err !== "object") return false;
  if (err instanceof Response) return err.status === 429 || err.status === 408 || err.status >= 500;
  const e = err as Errorish;
  const name = typeof e.name === "string" ? e.name : "";
  const message = typeof e.message === "string" ? e.message : "";
  // A timeout is a hiccup. An abort someone asked for is not, unless it came from a timeout.
  if (name === "TimeoutError") return true;
  if (name === "AbortError") return /time ?out|timed out/i.test(message) || isHiccup(e.cause, depth + 1);
  const status = statusOf(e);
  if (status !== null) return status === 429 || status === 408 || status >= 500;
  const code = typeof e.code === "string" ? e.code : "";
  if (code) {
    if (PG_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code) || NET_CODES.has(code)) return true;
    // Another Postgres or PostgREST code is a real answer, not a hiccup.
    if (/^[0-9A-Z]{5}$/.test(code) || /^PGRST/.test(code)) return false;
  }
  if (HICCUP_TEXT.test(message)) return true;
  return isHiccup(e.cause, depth + 1);
}

const headerOf = (headers: unknown, name: string): string | null => {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  if (typeof headers === "object") {
    const hit = Object.entries(headers as Record<string, unknown>).find(([k]) => k.toLowerCase() === name);
    return hit && hit[1] != null ? String(hit[1]) : null;
  }
  return null;
};

/** How long the other side asked us to wait (Retry-After or retry-after-ms), in ms, or null. */
export function retryAfterMs(err: unknown, now = Date.now()): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { headers?: unknown; retryAfterMs?: unknown };
  if (typeof e.retryAfterMs === "number" && e.retryAfterMs >= 0) return e.retryAfterMs;
  const headers = err instanceof Response ? err.headers : e.headers;
  const ms = Number(headerOf(headers, "retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const raw = headerOf(headers, "retry-after")?.trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Wait `ms`, or stop early with the signal's reason. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => {
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    const t = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** The wait before attempt `attempt + 1`: doubling from baseMs to maxMs, with the top half jittered. */
export function backoffMs(attempt: number, baseMs = 300, maxMs = 8000): number {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(cap / 2 + Math.random() * (cap / 2));
}

/**
 * Run `fn`, trying a hiccup again with growing waits. `fn` gets the attempt number (0 first) and whether it's the
 * last one. The last error is thrown as it was.
 */
export async function withRetry<T>(fn: (attempt: number, last: boolean) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const tries = Math.max(1, opts.tries ?? 4);
  const retryOn = opts.retryOn ?? isHiccup;
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    try {
      return await fn(attempt, attempt === tries - 1);
    } catch (err) {
      if (attempt >= tries - 1 || opts.signal?.aborted || !retryOn(err)) throw err;
      const asked = retryAfterMs(err);
      if (asked !== null && asked > (opts.maxRetryAfterMs ?? 30_000)) throw err;
      const backoff = backoffMs(attempt, opts.baseMs, opts.maxMs);
      const wait = asked !== null ? Math.round(asked + Math.random() * Math.min(1000, asked * 0.1)) : backoff;
      opts.onRetry?.(err, attempt, wait);
      await sleep(wait, opts.signal);
    }
  }
}

/**
 * For calls that answer `{ data, error }` instead of throwing (Supabase): a hiccup in `error` is tried again; the
 * last answer comes back as it was, so the caller decides what to say.
 */
export async function retryResult<R extends { error: unknown }>(fn: () => PromiseLike<R>, opts: RetryOptions = {}): Promise<R> {
  const retryOn = opts.retryOn ?? isHiccup;
  try {
    return await withRetry(
      async (_attempt, last) => {
        const answer = await fn();
        // Supabase puts the HTTP status on the answer, not the error: a busy gateway is a hiccup too.
        const status = (answer as { status?: unknown }).status;
        const busyGateway = status === 429 || status === 502 || status === 503 || status === 504;
        if (answer.error && !last && (retryOn(answer.error) || busyGateway)) throw new BusyAnswer(answer);
        return answer;
      },
      { ...opts, retryOn: (e) => e instanceof BusyAnswer || retryOn(e) },
    );
  } catch (err) {
    if (err instanceof BusyAnswer) return err.answer as R;
    throw err;
  }
}

class BusyAnswer {
  answer: unknown;
  constructor(answer: unknown) {
    this.answer = answer;
  }
}

export type FetchRetryOptions = RetryOptions & {
  /** Each attempt gets this long. */
  timeoutMs?: number;
  fetch?: typeof fetch;
};

/**
 * fetch with a timeout per attempt, trying network failures, timeouts, 408, 429 and 5xx again. Returns the answer
 * like fetch does (check `ok`): any other status at once, and a busy one when the tries run out. Throws when the
 * network never answered. Only send a body here that's safe to send twice (or carries an idempotency key).
 */
export async function fetchWithRetry(url: string | URL, init: RequestInit = {}, opts: FetchRetryOptions = {}): Promise<Response> {
  const doFetch = opts.fetch ?? fetch;
  return withRetry(async (_attempt, last) => {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const res = await doFetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });
    if (!last && (res.status === 429 || res.status === 408 || res.status >= 500)) {
      const body = await res.text().catch(() => "");
      throw new HttpStatusError(res.status, res.headers, body);
    }
    return res;
  }, opts);
}

export type BatchResult<T> = { ok: T[]; failed: { item: T; error: unknown }[] };

/**
 * Run `fn` over `items` in batches of `size` (all at once by default). A batch that fails is split in half and each
 * half run again, down to single items, so one bad item never stops the rest. Wrap `fn` in withRetry for hiccups.
 */
export async function splitBatch<T>(items: readonly T[], fn: (batch: T[]) => Promise<unknown>, opts: { size?: number } = {}): Promise<BatchResult<T>> {
  const result: BatchResult<T> = { ok: [], failed: [] };
  const run = async (batch: T[]): Promise<void> => {
    if (!batch.length) return;
    try {
      await fn(batch);
      result.ok.push(...batch);
    } catch (error) {
      if (batch.length === 1) {
        result.failed.push({ item: batch[0]!, error });
        return;
      }
      const half = Math.ceil(batch.length / 2);
      await run(batch.slice(0, half));
      await run(batch.slice(half));
    }
  };
  const size = Math.max(1, opts.size ?? (items.length || 1));
  for (let i = 0; i < items.length; i += size) await run(items.slice(i, i + size));
  return result;
}
