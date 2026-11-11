// Disconnect: POST { source_id } from an owner or admin of its workspace (the screen asks with askConfirm first).
// Deletes the source with its tokens and every row it brought in, drops its waiting jobs, and rebuilds the
// workspace's daily totals (delete_source). Answers { ok: true }, or one plain line.
import { retryResult } from "../../../../lib/retry.ts";
import { adminClient, errorResponse, HttpError, requireMember, requireUser } from "../../../../lib/serverAuth.ts";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const body = (await request.json().catch(() => null)) as { source_id?: unknown } | null;
    const sourceId = typeof body?.source_id === "string" ? body.source_id : "";
    if (!UUID.test(sourceId)) throw new HttpError(400, "Missing source.");
    await requireUser(request);
    const sb = adminClient();
    const found = await retryResult(() => sb.from("sources").select("workspace_id").eq("id", sourceId).maybeSingle());
    if (found.error) {
      console.error("Source lookup failed:", found.error.message);
      throw new HttpError(503, "We couldn't remove the source. Try again.");
    }
    const ws = (found.data as { workspace_id?: string } | null)?.workspace_id;
    if (!ws) throw new HttpError(404, "This source is already gone.");
    await requireMember(request, ws, { admin: true });
    const { error } = await retryResult(() => sb.rpc("delete_source", { p_source: sourceId }));
    if (error) {
      console.error("delete_source failed:", error.message);
      throw new HttpError(500, "We couldn't remove the source. Try again.");
    }
    return Response.json({ ok: true }, { headers });
  } catch (e) {
    return errorResponse(e, headers);
  }
}
