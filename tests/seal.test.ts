import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { isSealed, keyIsValid, parseKey, seal, unseal } from "../src/lib/seal.ts";

const RAW = randomBytes(32);
const B64 = RAW.toString("base64");
const HEX = RAW.toString("hex");

test("a sealed value opens with the same key and starts with v1:", () => {
  const sealed = seal("sk_live_123", B64);
  assert.match(sealed, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.ok(isSealed(sealed));
  assert.equal(unseal(sealed, B64), "sk_live_123");
  assert.equal(unseal(seal("", B64), B64), "");
  assert.equal(unseal(seal("héllo ✓", B64), B64), "héllo ✓");
});

test("the same value seals differently each time", () => {
  assert.notEqual(seal("same", B64), seal("same", B64));
});

test("a changed value or tag is caught", () => {
  const [v, iv, tag, body] = seal("sk_live_123", B64).split(":");
  const flipped = Buffer.from(body!, "base64");
  flipped[0]! ^= 1;
  assert.throws(() => unseal([v, iv, tag, flipped.toString("base64")].join(":"), B64));
  const badTag = Buffer.from(tag!, "base64");
  badTag[0]! ^= 1;
  assert.throws(() => unseal([v, iv, badTag.toString("base64"), body].join(":"), B64));
});

test("a different key can't open it", () => {
  assert.throws(() => unseal(seal("sk_live_123", B64), randomBytes(32).toString("base64")));
});

test("an unknown format is refused", () => {
  assert.throws(() => unseal("v2:a:b:c", B64), /format/);
  assert.throws(() => unseal("plain text", B64), /format/);
});

test("the key is read the same as base64, base64url or hex, with stray spaces and line breaks", () => {
  assert.deepEqual(parseKey(B64), RAW);
  assert.deepEqual(parseKey(HEX), RAW);
  assert.deepEqual(parseKey(HEX.toUpperCase()), RAW);
  assert.deepEqual(parseKey(RAW.toString("base64url")), RAW);
  assert.deepEqual(parseKey(`  ${B64.slice(0, 20)}\n${B64.slice(20)}\r\n`), RAW);
  // Sealed with the hex form, opened with the base64 form.
  assert.equal(unseal(seal("x", HEX), ` ${B64}\n`), "x");
});

test("a long passphrase works; a short or missing key is refused", () => {
  const phrase = "a-test-passphrase-that-is-long-enough-for-aes";
  assert.equal(unseal(seal("x", phrase), phrase), "x");
  assert.throws(() => seal("x", "short"), /SECRETS_KEY/);
  assert.throws(() => seal("x", ""), /SECRETS_KEY/);
  assert.throws(() => seal("x", undefined), /SECRETS_KEY/);
  assert.equal(keyIsValid(B64), true);
  assert.equal(keyIsValid("short"), false);
});
