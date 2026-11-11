// The backup connect path (Settings → Sources): POST { workspace_id, key } from an owner or admin, with a read-only
// restricted key (rk_live_ / rk_test_). The key is checked with Stripe (it reads the account, and can't write:
// src/lib/stripe/keys.ts), sealed, saved, and the import starts. Answers { ok: true, source_id }, or { error }.
// 10 tries an hour per person.
import { limit } from "../../../../lib/rate.ts";
import { keyIsValid, seal } from "../../../../lib/seal.ts";
import { adminClient, errorResponse, HttpError, requireMember } from "../../../../lib/serverAuth.ts";
import { saveSource } from "../../../../lib/sources.ts";
import { checkRestrictedKey, KeyCheckError, RESTRICTED_KEY } from "../../../../lib/stripe/index.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const body = (await request.json().catch(() => null)) as { workspace_id?: unknown; key?: unknown } | null;
    const caller = await requireMember(request, body?.workspace_id, { admin: true });
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    if (!RESTRICTED_KEY.test(key)) throw new HttpError(400, "Use a restricted key that starts with rk_live_ or rk_test_.");
    if (!keyIsValid()) throw new HttpError(503, "The server isn't set up yet.");
    if (!(await limit(`stripe_key:${caller.userId}`, 10, 3600))) throw new HttpError(429, "Too many tries. Wait an hour and try again.");

    let checked;
    try {
      checked = await checkRestrictedKey(key);
    } catch (e) {
      if (e instanceof KeyCheckError) throw new HttpError(e.problem === "unchecked" ? 503 : 400, e.message);
      throw e;
    }
    const sourceId = await saveSource(adminClient(), {
      workspaceId: body!.workspace_id as string,
      userId: caller.userId,
      kind: "stripe_key",
      accountId: checked.accountId,
      accountName: checked.accountName,
      livemode: checked.livemode,
      apiKey: seal(key),
      currency: checked.currency,
    });
    return Response.json({ ok: true, source_id: sourceId }, { headers });
  } catch (e) {
    return errorResponse(e, headers);
  }
}
