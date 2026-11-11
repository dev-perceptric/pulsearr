import assert from "node:assert/strict";
import { test } from "node:test";
import { json, stubFetch } from "./helpers/serverOnly.ts";

process.env.SUPABASE_URL = "https://db.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = "pk_test";
process.env.SUPABASE_SECRET_KEY = "sk_test";
process.env.SECRETS_KEY = "a-test-secret-key-that-is-long-enough-123";
process.env.SITE_ORIGINS = "https://pulsearr.com, https://www.pulsearr.com";
process.env.APP_URL = "https://app.pulsearr.com";
const { OPTIONS, POST } = await import("../src/app/api/waitlist/route.ts");
const health = await import("../src/app/api/health/route.ts");
const version = await import("../src/app/api/version/route.ts");
const setup = await import("../src/app/api/health/setup/route.ts");

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://app.pulsearr.com/api/waitlist", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://pulsearr.com", "X-Forwarded-For": "203.0.113.9, 10.0.0.1", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function db(o: { allowed?: boolean; isNew?: boolean; failAdds?: number } = {}) {
  let adds = 0;
  return stubFetch((url) => {
    if (url.pathname === "/rest/v1/rpc/take_rate") return json(o.allowed ?? true);
    if (url.pathname === "/rest/v1/rpc/add_to_waitlist") {
      if (++adds <= (o.failAdds ?? 0)) return json({ message: "upstream timeout" }, 503);
      return json(o.isNew ?? true);
    }
    return json({ message: "not found" }, 404);
  });
}

test("a new email is saved once, with a hashed address and the source", async () => {
  const s = db({ isNew: true });
  try {
    const res = await POST(post({ email: "  Ada@Example.com ", source: "home-hero" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, new: true });
    assert.equal(res.headers.get("access-control-allow-origin"), "https://pulsearr.com");
    const rate = JSON.parse(s.calls.find((c) => c.url.pathname.endsWith("take_rate"))!.body);
    assert.match(rate.p_bucket, /^waitlist:[0-9a-f]{64}$/);
    assert.equal(rate.p_limit, 5);
    assert.equal(rate.p_window_s, 3600);
    const add = JSON.parse(s.calls.find((c) => c.url.pathname.endsWith("add_to_waitlist"))!.body);
    assert.equal(add.p_email, "ada@example.com");
    assert.equal(add.p_source, "home-hero");
    assert.match(add.p_ip_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(s.calls.map((c) => c.body)).includes("203.0.113.9"), "the address is never sent as it is");
    const auth = new Headers(s.calls[0]!.init.headers).get("authorization") ?? new Headers(s.calls[0]!.init.headers).get("apikey");
    assert.ok(auth?.includes("sk_test"), "uses the server key");
  } finally {
    s.restore();
  }
});

test("an email already on the list answers new: false", async () => {
  const s = db({ isNew: false });
  try {
    assert.deepEqual(await (await POST(post({ email: "ada@example.com" }))).json(), { ok: true, new: false });
    assert.equal(JSON.parse(s.calls.at(-1)!.body).p_source, "site");
  } finally {
    s.restore();
  }
});

test("a plain form post works", async () => {
  const s = db();
  try {
    const res = await POST(post("email=ada%40example.com&source=footer", { "Content-Type": "application/x-www-form-urlencoded" }));
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(s.calls.at(-1)!.body).p_source, "footer");
  } finally {
    s.restore();
  }
});

test("a bad email is a plain 400 and nothing is saved", async () => {
  const s = db();
  try {
    for (const body of [{ email: "not-an-email" }, {}, "not json", { email: "a@b" }]) {
      const res = await POST(post(body));
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), { error: "That email doesn't look right." });
    }
    assert.equal(s.calls.length, 0);
  } finally {
    s.restore();
  }
});

test("past 5 an hour it's a plain 429", async () => {
  const s = db({ allowed: false });
  try {
    const res = await POST(post({ email: "ada@example.com" }));
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /Too many tries/);
    assert.ok(!s.calls.some((c) => c.url.pathname.endsWith("add_to_waitlist")));
  } finally {
    s.restore();
  }
});

test("a busy database is tried again before answering (flaky add_to_waitlist)", async () => {
  const s = db({ failAdds: 2 });
  try {
    const res = await POST(post({ email: "ada@example.com" }));
    assert.equal(res.status, 200);
    assert.equal(s.calls.filter((c) => c.url.pathname.endsWith("add_to_waitlist")).length, 3);
  } finally {
    s.restore();
  }
});

test("only the sites in SITE_ORIGINS may call it from a browser", async () => {
  const s = db();
  try {
    const pre = OPTIONS(new Request("https://app.pulsearr.com/api/waitlist", { method: "OPTIONS", headers: { Origin: "https://www.pulsearr.com" } }));
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://www.pulsearr.com");
    assert.match(pre.headers.get("access-control-allow-methods") ?? "", /POST/);
    const bad = OPTIONS(new Request("https://app.pulsearr.com/api/waitlist", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }));
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
    const res = await POST(post({ email: "ada@example.com" }, { Origin: "https://evil.example" }));
    assert.equal(res.status, 403);
    assert.equal(s.calls.length, 0);
  } finally {
    s.restore();
  }
});

test("health and version answer without the database", async () => {
  const s = stubFetch(() => {
    throw new Error("no network in this test");
  });
  try {
    assert.deepEqual(await health.GET().json(), { ok: true });
    process.env.NEXT_PUBLIC_BUILD = "abc123";
    assert.deepEqual(await version.GET().json(), { build: "abc123" });
    assert.equal(s.calls.length, 0);
  } finally {
    s.restore();
  }
});

test("setup reports booleans only, and whether the database answers", async () => {
  const s = stubFetch((url) => (url.pathname === "/rest/v1/workspaces" ? json([]) : json({}, 404)));
  try {
    const res = await setup.GET();
    const body = await res.json();
    assert.equal(body.db, true);
    assert.equal(body.secretsKeyValid, true);
    assert.equal(body.env.SUPABASE_SECRET_KEY, true);
    assert.equal(body.env.RESEND_API_KEY, Boolean(process.env.RESEND_API_KEY?.trim()));
    assert.ok(Object.values(body.env).every((v) => typeof v === "boolean"));
    assert.ok(!JSON.stringify(body).includes("sk_test"));
    assert.equal(res.status, body.ok ? 200 : 503);
  } finally {
    s.restore();
  }
});
