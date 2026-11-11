// The app shell's pure parts: the boot kept per person (bad JSON, another person's, storage that throws), the
// workspace it opens, who may do what on the team, and which section an address opens. Plus rpcWrite: hiccups are
// tried again, the database's own plain lines come back as they are, and technical ones never do.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  BOOT_KEY,
  PREF_KEY,
  canDeleteWorkspace,
  canEditRole,
  canInvite,
  canRename,
  forgetBoot,
  memberAction,
  navOf,
  parseBoot,
  parseTeam,
  pickWorkspace,
  readBoot,
  readPref,
  sameBoot,
  saveBoot,
  savePref,
  sectionOf,
  type Boot,
  type Store,
} from "../src/components/shellState.ts";
import { rpcWrite } from "../src/components/rpcWrite.ts";

function memory(): Store & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)), removeItem: (k) => void map.delete(k) };
}
const broken: Store = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

const A = { id: "11111111-1111-4111-8111-111111111111", name: "Acme", role: "owner" as const };
const B = { id: "22222222-2222-4222-8222-222222222222", name: "Beta", role: "member" as const };
const boot: Boot = { user: { id: "u1", email: "ana@acme.com" }, workspace: A, workspaces: [A, B] };

test("a saved boot comes back for the same person only", () => {
  const s = memory();
  saveBoot(s, boot);
  assert.deepEqual(readBoot(s, "u1"), boot);
  assert.equal(readBoot(s, "u2"), null, "someone else signed in on this browser");
  assert.equal(readBoot(s, ""), null);
});

test("bad JSON, a wrong shape or blocked storage reads as no boot, never a crash", () => {
  const s = memory();
  for (const raw of ["{", "null", "[]", '"x"', "42", '{"user":{"id":"u1"}}', '{"user":"u1","workspaces":[]}']) {
    s.map.set(BOOT_KEY, raw);
    assert.equal(readBoot(s, "u1"), null, raw);
  }
  assert.equal(readBoot(broken, "u1"), null);
  assert.equal(readBoot(null, "u1"), null);
  assert.doesNotThrow(() => saveBoot(broken, boot));
  assert.doesNotThrow(() => forgetBoot(broken));
  assert.doesNotThrow(() => savePref(broken, A.id));
  assert.equal(readPref(broken), null);
});

test("rows with a bad role or missing id drop out of a boot", () => {
  const b = parseBoot({ user: { id: "u1", email: 5 }, workspace: A, workspaces: [A, { id: "x", name: "X", role: "superuser" }, { name: "No id", role: "admin" }, null] });
  assert.deepEqual(b, { user: { id: "u1", email: null }, workspace: A, workspaces: [A] });
});

test("the workspace that opens: boot's pick when it's in the list, else the first, else none", () => {
  assert.deepEqual(pickWorkspace(B, [A, B]), B);
  assert.deepEqual(pickWorkspace({ ...B, id: "gone" }, [A]), A);
  assert.deepEqual(pickWorkspace(null, [B, A]), B);
  assert.equal(pickWorkspace(null, []), null);
  assert.deepEqual(parseBoot({ user: { id: "u1", email: "a@b.co" }, workspace: null, workspaces: [B] })?.workspace, B);
});

test("forgetting on sign-out clears the boot and the picked workspace", () => {
  const s = memory();
  saveBoot(s, boot);
  savePref(s, A.id);
  forgetBoot(s);
  assert.equal(s.map.size, 0);
});

test("the picked workspace is kept only when it's a real id", () => {
  const s = memory();
  savePref(s, B.id);
  assert.equal(readPref(s), B.id);
  s.map.set(PREF_KEY, "not-a-uuid");
  assert.equal(readPref(s), null);
  savePref(s, null);
  assert.equal(s.map.has(PREF_KEY), false);
});

test("sameBoot spots a refresh that changed nothing", () => {
  assert.ok(sameBoot(boot, JSON.parse(JSON.stringify(boot))));
  assert.ok(!sameBoot(boot, { ...boot, workspace: { ...A, name: "Acme Inc" } }));
});

test("who may do what on the team", () => {
  assert.ok(canRename("owner") && canRename("admin") && !canRename("member") && !canRename(null));
  assert.ok(canInvite("admin") && !canInvite("member"));
  assert.ok(canDeleteWorkspace("owner") && !canDeleteWorkspace("admin") && !canDeleteWorkspace("member"));

  const owner = { id: "o", role: "owner" as const };
  const admin = { id: "a", role: "admin" as const };
  const member = { id: "m", role: "member" as const };
  const row = (user_id: string, role: "owner" | "admin" | "member") => ({ user_id, role });

  // Roles: admins and the owner change others' roles, never the owner's, never their own.
  assert.ok(canEditRole(owner, row("m", "member")));
  assert.ok(canEditRole(admin, row("x", "admin")));
  assert.ok(!canEditRole(admin, row("o", "owner")));
  assert.ok(!canEditRole(admin, row("a", "admin")), "not your own");
  assert.ok(!canEditRole(member, row("x", "member")));

  // Removing: admins remove others; anyone but the owner can leave; nobody removes the owner.
  assert.equal(memberAction(admin, row("m", "member")), "remove");
  assert.equal(memberAction(owner, row("a", "admin")), "remove");
  assert.equal(memberAction(member, row("x", "member")), null);
  assert.equal(memberAction(member, row("m", "member")), "leave");
  assert.equal(memberAction(admin, row("a", "admin")), "leave");
  assert.equal(memberAction(owner, row("o", "owner")), null, "the owner can't leave");
  assert.equal(memberAction(admin, row("o", "owner")), null);
});

test("parseTeam keeps good rows and drops the rest", () => {
  const t = parseTeam({
    members: [{ user_id: "u1", email: "a@b.co", role: "owner", created_at: "2026-11-01" }, { user_id: "u2", role: "member" }, "x"],
    invites: [{ id: "i1", email: "c@b.co", role: "admin", created_at: "2026-11-02" }, { id: "i2", email: "d@b.co", role: "owner" }],
  });
  assert.deepEqual(t.members.map((m) => m.user_id), ["u1"]);
  assert.deepEqual(t.invites.map((i) => i.id), ["i1"]);
  assert.deepEqual(parseTeam(null), { members: [], invites: [] });
});

test("addresses: settings sections and the picked sidebar item", () => {
  assert.equal(sectionOf("/settings/team"), "team");
  assert.equal(sectionOf("/settings/account?x=1"), "account");
  assert.equal(sectionOf("/settings"), "workspace");
  assert.equal(sectionOf("/settings/nope"), "workspace");
  assert.equal(navOf("/dashboard"), "dashboard");
  assert.equal(navOf("/settings/team"), "settings");
  assert.equal(navOf("/settingsx"), null);
  assert.equal(sectionOf("/settings/sources?error=access_denied"), "sources");
  assert.equal(navOf("/feed"), "feed");
  assert.equal(navOf("/metrics/mrr"), "dashboard", "a metric page sits under the dashboard");
  assert.equal(navOf("/metricsx"), null);
  assert.equal(navOf("/feedback"), null);
});

// A fake Supabase client: each rpc call answers the next queued reply.
function fakeRpc(replies: unknown[]) {
  const calls: { fn: string; args: unknown }[] = [];
  return {
    calls,
    rpc: ((fn: string, args: unknown) => {
      calls.push({ fn, args });
      const r = replies.shift();
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }) as never,
  };
}

test("rpcWrite tries a hiccup again, then succeeds", async () => {
  const sb = fakeRpc([
    { data: null, error: { message: "fetch failed" }, status: 0 },
    { data: null, error: { message: "Service Unavailable" }, status: 503 },
    { data: "id-1", error: null, status: 200 },
  ]);
  const r = await rpcWrite(sb, "invite_member", { p_email: "a@b.co" }, { baseMs: 1 });
  assert.deepEqual(r, { ok: true, data: "id-1" });
  assert.equal(sb.calls.length, 3);
});

test("rpcWrite returns the database's plain line once, without retrying", async () => {
  const sb = fakeRpc([{ data: null, error: { message: "Already on the team", code: "P0001" }, status: 400 }]);
  const r = await rpcWrite(sb, "invite_member", {}, { baseMs: 1 });
  assert.deepEqual(r, { ok: false, hiccup: false, message: "Already on the team" });
  assert.equal(sb.calls.length, 1);
});

test("rpcWrite never shows a technical message, and a hiccup that outlasts the retries says so", async () => {
  const tech = await rpcWrite(fakeRpc([{ data: null, error: { message: 'permission denied for function invite_member', code: "42501" }, status: 403 }]), "invite_member", {}, { baseMs: 1 });
  assert.equal(tech.ok, false);
  assert.ok(!tech.ok && !tech.hiccup && !/permission|function/.test(tech.message));
  const busy = Array.from({ length: 4 }, () => ({ data: null, error: { message: "Gateway Timeout" }, status: 504 }));
  const gone = await rpcWrite(fakeRpc(busy), "rename_workspace", {}, { baseMs: 1 });
  assert.ok(!gone.ok && gone.hiccup);
  const offline = await rpcWrite(fakeRpc(Array.from({ length: 4 }, () => new TypeError("fetch failed"))), "rename_workspace", {}, { baseMs: 1 });
  assert.ok(!offline.ok && offline.hiccup);
});

test("the email templates exist, carry the code and the link, and have no emoji or exclamation points", () => {
  for (const name of ["magic-link", "confirmation", "invite", "email-change"]) {
    const p = `public/email-templates/${name}.html`;
    assert.ok(existsSync(p), p);
    const html = readFileSync(p, "utf8");
    assert.ok(html.includes("{{ .ConfirmationURL }}"), `${name} links to {{ .ConfirmationURL }}`);
    if (name === "magic-link" || name === "confirmation") assert.ok(html.includes("{{ .Token }}"), `${name} shows the code`);
    const text = html.replace(/<[^>]+>/g, " ");
    assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]|!|—/u.test(text), `${name}: no emoji, exclamation points or em dashes`);
    assert.ok(html.includes('width="600"'), `${name} is 600px wide`);
  }
  const env = readFileSync("deploy/sb-pulsearr/auth.env.example", "utf8");
  for (const kind of ["MAGIC_LINK", "CONFIRMATION", "INVITE", "EMAIL_CHANGE"]) {
    const file = kind.toLowerCase().replace("_", "-");
    assert.ok(env.includes(`GOTRUE_MAILER_TEMPLATES_${kind}=https://app.pulsearr.com/email-templates/${file}.html`), kind);
  }
});
