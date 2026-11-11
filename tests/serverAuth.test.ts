import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { json, stubFetch } from "./helpers/serverOnly.ts";

process.env.SUPABASE_URL = "https://db.example.test/";
process.env.SUPABASE_PUBLISHABLE_KEY = "pk_test";
process.env.SUPABASE_SECRET_KEY = "sk_test";
const { adminClient, errorResponse, forgetAuth, HttpError, requireMember, requireUser } = await import("../src/lib/serverAuth.ts");

const WS = "11111111-1111-4111-8111-111111111111";
const USER = { id: "u1", email: "ada@example.com", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-11-11T00:00:00Z" };
const req = (token?: string) => new Request("https://app.example.test/api/x", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const quiet = <T>(fn: () => Promise<T>) => {
  const err = console.error;
  console.error = () => {};
  return fn().finally(() => (console.error = err));
};

function supabase(o: { member?: boolean; admin?: boolean; userStatus?: number; busyChecks?: number } = {}) {
  let checks = 0;
  return stubFetch((url) => {
    if (url.pathname === "/auth/v1/user") return o.userStatus ? json({ msg: "bad" }, o.userStatus) : json(USER);
    if (url.pathname.startsWith("/rest/v1/rpc/") && ++checks <= (o.busyChecks ?? 0)) return json({ message: "bad gateway" }, 502);
    if (url.pathname === "/rest/v1/rpc/is_member") return json(o.member ?? true);
    if (url.pathname === "/rest/v1/rpc/is_admin") return json(o.admin ?? false);
    return json({ message: "not found" }, 404);
  });
}

beforeEach(() => forgetAuth());

test("no token is a 401 with a plain line", async () => {
  await assert.rejects(requireUser(req()), (e: unknown) => e instanceof HttpError && e.status === 401 && e.message === "Please sign in again.");
});

test("a bad token is a 401", async () => {
  const s = supabase({ userStatus: 403 });
  try {
    await assert.rejects(requireUser(req("bad")), (e: unknown) => e instanceof HttpError && e.status === 401);
  } finally {
    s.restore();
  }
});

test("a signed-in member passes, and the check is remembered for 30 seconds", async () => {
  const s = supabase();
  try {
    const first = await requireMember(req("tok-1"), WS);
    assert.equal(first.userId, "u1");
    const second = await requireMember(req("tok-1"), WS);
    assert.equal(second.userId, "u1");
    assert.deepEqual(s.calls.map((c) => c.url.pathname), ["/auth/v1/user", "/rest/v1/rpc/is_member"]);
    assert.deepEqual(JSON.parse(s.calls[1]!.body), { ws: WS });
  } finally {
    s.restore();
  }
});

test("someone outside the workspace is a 403; a bad workspace id is a 400", async () => {
  const s = supabase({ member: false });
  try {
    await assert.rejects(requireMember(req("tok-2"), WS), (e: unknown) => e instanceof HttpError && e.status === 403);
    await assert.rejects(requireMember(req("tok-2"), "not-a-uuid"), (e: unknown) => e instanceof HttpError && e.status === 400);
  } finally {
    s.restore();
  }
});

test("admin actions need an owner or admin (is_admin)", async () => {
  let s = supabase({ admin: false });
  try {
    await assert.rejects(requireMember(req("tok-3"), WS, { admin: true }), (e: unknown) => e instanceof HttpError && e.status === 403 && /owners and admins/.test(e.message));
    assert.deepEqual(JSON.parse(s.calls.find((c) => c.url.pathname.endsWith("/is_admin"))!.body), { ws: WS });
  } finally {
    s.restore();
  }
  forgetAuth();
  s = supabase({ admin: true });
  try {
    assert.equal((await requireMember(req("tok-4"), WS)).admin, null);
    assert.equal((await requireMember(req("tok-4"), WS, { admin: true })).admin, true);
    assert.equal(s.calls.filter((c) => c.url.pathname.endsWith("/is_admin")).length, 1);
  } finally {
    s.restore();
  }
});

test("a busy gateway during the membership check is tried again (flaky is_member)", async () => {
  const s = supabase({ busyChecks: 2 });
  try {
    assert.equal((await requireMember(req("tok-6"), WS)).userId, "u1");
    assert.equal(s.calls.filter((c) => c.url.pathname.endsWith("/is_member")).length, 3);
  } finally {
    s.restore();
  }
});

test("a failing auth server is a 503, not a sign-out", async () => {
  const s = stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    await quiet(() => assert.rejects(requireUser(req("tok-5")), (e: unknown) => e instanceof HttpError && e.status === 503));
  } finally {
    s.restore();
  }
});

test("missing setup is a plain 500, with the cause only in the log", async () => {
  const url = process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SECRET_KEY;
  try {
    await quiet(async () => assert.throws(() => adminClient(), (e: unknown) => e instanceof HttpError && e.status === 500 && !/SUPABASE/.test(e.message)));
  } finally {
    process.env.SUPABASE_SECRET_KEY = url;
  }
  assert.ok(adminClient());
});

test("errorResponse sends an HttpError as it is and hides anything else", async () => {
  const a = errorResponse(new HttpError(403, "You are not in this workspace."));
  assert.equal(a.status, 403);
  assert.deepEqual(await a.json(), { error: "You are not in this workspace." });
  const b = await quiet(async () => errorResponse(new Error('relation "x" does not exist')));
  assert.equal(b.status, 500);
  assert.deepEqual(await b.json(), { error: "Something went wrong. Try again." });
});
