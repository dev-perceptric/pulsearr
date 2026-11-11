import assert from "node:assert/strict";
import { test } from "node:test";
import { friendlyError } from "../src/lib/friendlyError.ts";
import { afterSignin, authUrl, HOME, isSignup } from "../src/lib/signin.ts";

test("home is the dashboard", () => {
  assert.equal(HOME, "/dashboard");
});

test("signed out, a deep link is kept in ?next=", () => {
  assert.equal(authUrl("/settings/team", "?tab=invites"), `/signin?next=${encodeURIComponent("/settings/team?tab=invites")}`);
  assert.equal(authUrl("/", "?utm_source=blog"), "/signin?utm_source=blog");
  assert.equal(authUrl("/dashboard", ""), "/signin");
  assert.equal(authUrl("/signup", "?utm_source=x"), "/signup?utm_source=x");
});

test("after sign-in, only a safe next on this site is followed", () => {
  assert.equal(afterSignin("?next=%2Fsettings%2Fteam"), "/settings/team");
  assert.equal(afterSignin(""), HOME);
  for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com", "/signin", "/signup?x=1", "/ok\nevil", "javascript:alert(1)"]) {
    assert.equal(afterSignin(`?next=${encodeURIComponent(bad)}`), HOME, bad);
  }
});

test("isSignup", () => {
  assert.ok(isSignup("/signup"));
  assert.ok(!isSignup("/signin"));
});

test("friendlyError turns technical messages into one plain line", () => {
  assert.equal(friendlyError(new Error("Token has expired or is invalid")), "That code didn't work. Check it or send a new one.");
  assert.equal(friendlyError({ message: "Email rate limit exceeded" }), "Too many tries in a short time. Wait a minute and try again.");
  assert.equal(friendlyError(new TypeError("Failed to fetch")), "We couldn't reach the server. Check your connection and try again.");
  assert.equal(friendlyError("relation \"workspaces\" does not exist"), "Something went wrong. Try again.");
  assert.equal(friendlyError("Signups not allowed for this instance"), "Sign-ups are closed for this address.");
  assert.equal(friendlyError("You are not in this workspace."), "You are not in this workspace.");
  assert.equal(friendlyError(null, "Try again."), "Try again.");
});
