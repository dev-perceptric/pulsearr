// Errors people may read: our own short lines pass, anything technical becomes one plain line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isTechnical, plainError } from "../src/lib/plainError.ts";

const quiet = <T,>(fn: () => T): T => {
  const was = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = was;
  }
};

test("database messages, codes and missing migrations never reach people", () => {
  for (const m of [
    'new row for relation "workspaces" violates check constraint "x"',
    "Run supabase/migrations/004_jobs.sql in Supabase first.",
    "Could not find the 'role' column of 'members' in the schema cache",
    "PGRST204: column missing",
    "TypeError: Failed to fetch",
    "Request failed with status code 500",
    'duplicate key value violates unique constraint "invites_email"',
    '{"code":"42501","message":"permission denied for table members"}',
    "x".repeat(400),
  ])
    assert.equal(quiet(() => plainError(m, "Couldn't save the settings")), "Couldn't save the settings", m);
});

test("our own short lines pass, with names, emails and variables in them", () => {
  for (const m of ["Couldn't reach Stripe", "There's a workspace with that name", "Sent to Pat Home and ann_lee_smith@acme.com", "Add a value for {{first_name}}", "Copied Pat's link", "Only owners and admins can invite"]) {
    assert.equal(isTechnical(m), false, m);
    assert.equal(plainError(m), m);
  }
  assert.equal(plainError(new Error("Couldn't load the activity")), "Couldn't load the activity");
  assert.equal(plainError(null), "Something went wrong. Try again.");
  assert.equal(plainError({ message: "" }, "Try again"), "Try again");
});
