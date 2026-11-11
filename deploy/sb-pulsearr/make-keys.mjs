// Prints a fresh set of values for /docker/sb-pulsearr/.env. Run it once, on the server, and keep the output out of
// chat and the repo:
//   docker run --rm -v "$PWD":/w node:22-alpine node /w/make-keys.mjs > .env && chmod 600 .env
// Then compare it with /docker/sb-arrowsterr/.env and match that file's names and key format.
import { createHmac, randomBytes } from "node:crypto";

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const jwtSecret = randomBytes(32).toString("hex");
const now = Math.floor(Date.now() / 1000);
const tenYears = 10 * 365 * 24 * 3600;

function sign(role) {
  const head = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ role, iss: "supabase", iat: now, exp: now + tenYears })}`;
  return `${head}.${createHmac("sha256", jwtSecret).update(head).digest("base64url")}`;
}

const lines = [
  `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}`,
  `JWT_SECRET=${jwtSecret}`,
  "JWT_EXP=3600",
  `ANON_KEY=${sign("anon")}`,
  `SERVICE_ROLE_KEY=${sign("service_role")}`,
  `PUBLISHABLE_KEY=sb_publishable_${randomBytes(16).toString("base64url")}`,
  `SECRET_KEY=sb_secret_${randomBytes(24).toString("base64url")}`,
];
process.stdout.write(lines.join("\n") + "\n");
