// The Connect webhook (events on connected accounts): POST from Stripe with the raw event and Stripe-Signature.
// Checks the signature (STRIPE_CONNECT_WEBHOOK_SECRET), then stores the event once for every source connected to
// event.account in that mode and enqueues stripe.sync_object for the object it's about, which fetches it fresh
// (record_stripe_event). Answers 200 quickly: an account we don't have, or a platform event, is ignored with 200;
// a bad signature is 400; a database failure is 500, so Stripe sends it again. The event's copy of the object is
// never trusted.
import { stripeWebhookSecret } from "../../../../lib/env.ts";
import { retryResult } from "../../../../lib/retry.ts";
import { adminClient } from "../../../../lib/serverAuth.ts";
import { eventRow, parseEvent, SignatureError, verifySignature } from "../../../../lib/stripe/index.ts";

export const dynamic = "force-dynamic";

const reply = (body: object, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const MAX_BODY = 1_000_000;

export async function POST(request: Request) {
  const secret = stripeWebhookSecret();
  if (!secret) {
    console.error("Server setup: STRIPE_CONNECT_WEBHOOK_SECRET is missing");
    return reply({ error: "Not set up" }, 500);
  }
  const body = await request.text();
  if (body.length > MAX_BODY) return reply({ error: "Too large" }, 413);
  try {
    verifySignature(body, request.headers.get("stripe-signature"), secret);
  } catch (e) {
    if (e instanceof SignatureError) return reply({ error: "Bad signature" }, 400);
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return reply({ error: "Bad event" }, 400);
  }
  const event = parseEvent(raw);
  if (!event) return reply({ error: "Bad event" }, 400);
  if (!event.account) return reply({ received: true, ignored: "platform event" });

  try {
    const sb = adminClient();
    if (event.type === "account.application.deauthorized") {
      const { error } = await retryResult(() => sb.rpc("source_deauthorized", { p_account: event.account, p_livemode: event.livemode }));
      if (error) throw new Error(error.message);
      return reply({ received: true });
    }
    const { data, error } = await retryResult(() => sb.rpc("record_stripe_event", { p_account: event.account, p_livemode: event.livemode, p_event: eventRow(event) }));
    if (error) throw new Error(error.message);
    return reply(Number(data) > 0 ? { received: true } : { received: true, ignored: "unknown account" });
  } catch (e) {
    console.error(`Stripe webhook ${event.id} not stored:`, e instanceof Error ? e.message : e);
    return reply({ error: "Not stored" }, 500);
  }
}
