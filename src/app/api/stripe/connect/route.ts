// "Connect Stripe": POST { workspace_id } from an owner or admin → { url }, Stripe's install page for the PulseARR
// Stripe App. The client navigates there. The state in the URL is sealed with the workspace, the person and a
// nonce, and the nonce also goes into a short-lived cookie, so the callback only accepts an install this browser
// started (someone else's install link can't connect their Stripe to your workspace, or yours to theirs).
import { stripeAppClientId, stripeAppTestLink } from "../../../../lib/env.ts";
import { keyIsValid } from "../../../../lib/seal.ts";
import { errorResponse, HttpError, requireMember } from "../../../../lib/serverAuth.ts";
import { callbackUrl, stateCookie } from "../../../../lib/sources.ts";
import { installUrl, newNonce, sealState, STATE_TTL_MS } from "../../../../lib/stripe/index.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { workspace_id?: unknown } | null;
    const caller = await requireMember(request, body?.workspace_id, { admin: true });
    const clientId = stripeAppClientId();
    if (!clientId) throw new HttpError(503, "Connecting Stripe isn't set up yet.");
    if (!keyIsValid()) throw new HttpError(503, "The server isn't set up yet.");
    const nonce = newNonce();
    const state = sealState({ workspaceId: body!.workspace_id as string, userId: caller.userId, nonce });
    return Response.json(
      { url: installUrl(clientId, callbackUrl(), state, stripeAppTestLink() || undefined) },
      { headers: { "Cache-Control": "no-store", "Set-Cookie": stateCookie(nonce, Math.floor(STATE_TTL_MS / 1000)) } },
    );
  } catch (e) {
    return errorResponse(e, { "Cache-Control": "no-store" });
  }
}
