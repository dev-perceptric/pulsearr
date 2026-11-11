import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Secrets (Stripe tokens from M1) are sealed with AES-256-GCM before they reach the database, using SECRETS_KEY,
// which only the servers hold. Format: v1:<iv>:<tag>:<ciphertext>, each part base64. The prefix lets a later
// version be added. SECRETS_KEY is set once and never rotated without a re-seal script: changing it makes every
// sealed value unreadable.

export const SEAL_PREFIX = "v1:";

/**
 * The 32-byte key from SECRETS_KEY. Tolerant of how it was pasted: whitespace and line breaks anywhere are dropped,
 * then 64 hex characters or base64 (or base64url) of 32 bytes are used as they are, and any other value of 32 or
 * more characters is hashed with SHA-256.
 */
export function parseKey(secret: string | undefined): Buffer {
  const s = (secret ?? "").replace(/\s+/g, "");
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, "hex");
  if (/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(s)) {
    const bytes = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (bytes.length === 32) return bytes;
  }
  if (s.length >= 32) return createHash("sha256").update(s).digest();
  throw new Error("Add SECRETS_KEY: 32 random bytes as base64 or hex (openssl rand -base64 32).");
}

/** True when SECRETS_KEY is set and usable. */
export function keyIsValid(secret = process.env.SECRETS_KEY): boolean {
  try {
    parseKey(secret);
    return true;
  } catch {
    return false;
  }
}

export function seal(value: string, secret = process.env.SECRETS_KEY): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", parseKey(secret), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return SEAL_PREFIX + [iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

export function unseal(sealed: string, secret = process.env.SECRETS_KEY): string {
  const [version, iv, tag, body] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || body === undefined) throw new Error("This secret is not in a format PulseARR can read.");
  const decipher = createDecipheriv("aes-256-gcm", parseKey(secret), Buffer.from(iv, "base64"), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

/** True when a value looks sealed. */
export const isSealed = (value: unknown): value is string => typeof value === "string" && value.startsWith(SEAL_PREFIX);
