// Is each setting present, and does the database answer with the server key. Booleans only, never values.
import { setupReport } from "../../../../lib/env.ts";
import { keyIsValid } from "../../../../lib/seal.ts";
import { adminClient } from "../../../../lib/serverAuth.ts";

export const dynamic = "force-dynamic";

const REQUIRED = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "SECRETS_KEY", "APP_URL"] as const;
/** Connecting Stripe and receiving its webhooks (M1). Reported on its own so the app still answers ok without them. */
const STRIPE = ["STRIPE_SECRET_KEY", "STRIPE_APP_CLIENT_ID", "STRIPE_CONNECT_WEBHOOK_SECRET"] as const;

async function dbAnswers(): Promise<boolean> {
  try {
    const { error } = await adminClient().from("workspaces").select("id").limit(1).abortSignal(AbortSignal.timeout(5000));
    if (error) console.error("Setup check: database:", error.message);
    return !error;
  } catch (e) {
    console.error("Setup check: database:", e instanceof Error ? e.message : e);
    return false;
  }
}

export async function GET() {
  const env = setupReport();
  const db = await dbAnswers();
  const secretsKeyValid = keyIsValid();
  const ok = db && secretsKeyValid && REQUIRED.every((n) => env[n]);
  const stripe = STRIPE.every((n) => env[n]);
  return Response.json({ ok, db, secretsKeyValid, stripe, env }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
