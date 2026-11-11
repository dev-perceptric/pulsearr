import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EmailError, esc, inviteEmail, sendEmail, type Email } from "../src/lib/email.ts";

const mail: Email = { to: "ada@example.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi", idempotencyKey: "inv-1" };
const fast = { baseMs: 1, maxMs: 4 };

function fakeFetch(answers: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return next();
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test("sendEmail posts to Resend with the key and the idempotency key", async () => {
  const { f, calls } = fakeFetch([() => json({ id: "em_1" })]);
  assert.deepEqual(await sendEmail({ ...mail, replyTo: "help@pulsearr.com" }, { fetch: f, apiKey: "re_test" }), { id: "em_1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.resend.com/emails");
  const h = calls[0]!.init.headers as Record<string, string>;
  assert.equal(h.Authorization, "Bearer re_test");
  assert.equal(h["Idempotency-Key"], "inv-1");
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual(body.to, ["ada@example.com"]);
  assert.equal(body.reply_to, "help@pulsearr.com");
  assert.equal(body.text, "Hi");
  assert.ok(body.from);
});

test("a busy Resend is tried again with the same idempotency key", async () => {
  const { f, calls } = fakeFetch([() => json({ message: "busy" }, 503), () => { throw new TypeError("fetch failed"); }, () => json({ id: "em_2" })]);
  assert.deepEqual(await sendEmail(mail, { fetch: f, apiKey: "re_test", retry: fast }), { id: "em_2" });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => (c.init.headers as Record<string, string>)["Idempotency-Key"] === "inv-1"));
});

test("a refused email isn't retried and says it can't be", async () => {
  const { f, calls } = fakeFetch([() => json({ name: "validation_error", message: "Invalid `to` field" }, 422)]);
  await assert.rejects(sendEmail(mail, { fetch: f, apiKey: "re_test", retry: fast }), (e: unknown) => e instanceof EmailError && e.status === 422 && !e.retry);
  assert.equal(calls.length, 1);
});

test("without a key, sending is a quiet no-op outside production", async () => {
  const { f, calls } = fakeFetch([() => json({ id: "x" })]);
  const env = process.env.NODE_ENV;
  const info = console.info;
  console.info = () => {};
  try {
    process.env.NODE_ENV = "test";
    assert.deepEqual(await sendEmail(mail, { fetch: f, apiKey: "" }), { skipped: true });
    process.env.NODE_ENV = "production";
    await assert.rejects(sendEmail(mail, { fetch: f, apiKey: "" }), /RESEND_API_KEY/);
  } finally {
    process.env.NODE_ENV = env;
    console.info = info;
  }
  assert.equal(calls.length, 0);
});

test("esc makes text safe for HTML", () => {
  assert.equal(esc(`<a href="x">Tom & 'Jerry'</a>`), "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;");
});

test("the invite email has one serif line, one button and a plain-text version", () => {
  const m = inviteEmail({ workspaceName: "Acme <Labs>", inviterEmail: "lin@acme.com", appUrl: "https://app.pulsearr.com/" });
  assert.equal(m.subject, "Join Acme <Labs> on PulseARR");
  assert.ok(m.html.includes("Join Acme &lt;Labs&gt;"));
  assert.ok(!m.html.includes("<Labs>"), "the workspace name must be escaped");
  assert.ok(m.html.includes('href="https://app.pulsearr.com/signin"'));
  assert.ok(m.html.includes("#000522"), "navy header strip");
  assert.equal((m.html.match(/<h1/g) ?? []).length, 1);
  assert.equal((m.html.match(/<a /g) ?? []).length, 1);
  assert.ok(m.text.includes("lin@acme.com invited you to the Acme <Labs> workspace."));
  assert.ok(m.text.includes("Join Acme <Labs>: https://app.pulsearr.com/signin"));
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]|!|—/u.test(m.text + m.subject), "no emoji, exclamation points or em dashes");
  const anon = inviteEmail({ workspaceName: "Acme", inviterEmail: null, appUrl: "https://app.pulsearr.com" });
  assert.ok(anon.text.startsWith("Join Acme on PulseARR"));
  assert.ok(anon.text.includes("Someone on your team invited you"));
});

test("Resend's address appears only in src/lib/email.ts", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|mjs|js)$/.test(n) ? [p] : [];
    });
  const hits = [...files("src"), ...files("worker")].filter((f) => readFileSync(f, "utf8").includes("api.resend.com"));
  assert.deepEqual(hits, [join("src", "lib", "email.ts")]);
});
