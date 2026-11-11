// Lets plain `node --test` load server files that `import "server-only"` (that package throws outside Next's
// server build). Import this first, then load the server file with a dynamic import(): static imports are resolved
// before this file runs.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true, format: "module" };
    return next(specifier, context);
  },
});

/** Replace global fetch for one test; returns the calls seen and a function that puts fetch back. */
export function stubFetch(answer: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const real = globalThis.fetch;
  const calls: { url: URL; init: RequestInit; body: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = input instanceof Request ? input.headers : init.headers;
    const merged = { ...init, headers };
    const body = typeof init.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : "";
    calls.push({ url, init: merged, body });
    return answer(url, merged);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
