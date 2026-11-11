// The pulsearr.com waitlist form posts here (JSON or a plain form). Saved once per email, 5 tries an hour per
// address. Only the sites in SITE_ORIGINS may call it from a browser.
import { z } from "zod";
import { appUrl, siteOrigins } from "../../../lib/env.ts";
import { clientIp, ipHash, limit } from "../../../lib/rate.ts";
import { retryResult } from "../../../lib/retry.ts";
import { adminClient } from "../../../lib/serverAuth.ts";

export const dynamic = "force-dynamic";

const Body = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  source: z
    .string()
    .trim()
    .max(60)
    .regex(/^[\w.:/-]*$/)
    .optional()
    .catch(undefined),
});

/** CORS headers for an allowed origin; null when the origin isn't allowed. No origin (a server or curl) is fine. */
function corsFor(request: Request): Record<string, string> | null {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  const own = new URL(appUrl()).origin;
  if (origin !== own && !siteOrigins().includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const reply = (body: object, status: number, headers: Record<string, string>) =>
  Response.json(body, { status, headers: { ...headers, "Cache-Control": "no-store" } });

export function OPTIONS(request: Request) {
  const cors = corsFor(request);
  if (!cors) return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  return new Response(null, { status: 204, headers: cors });
}

async function readBody(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) return await request.json();
    if (type.includes("form")) return Object.fromEntries((await request.formData()).entries());
    return JSON.parse(await request.text());
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const cors = corsFor(request);
  if (!cors) return reply({ error: "This site can't use the waitlist." }, 403, { Vary: "Origin" });

  const parsed = Body.safeParse(await readBody(request));
  if (!parsed.success) return reply({ error: "That email doesn't look right." }, 400, cors);

  try {
    const hash = ipHash(clientIp(request.headers));
    if (!(await limit(`waitlist:${hash}`, 5, 3600))) return reply({ error: "Too many tries. Wait an hour and try again." }, 429, cors);

    const sb = adminClient();
    const { data, error } = await retryResult(() => sb.rpc("add_to_waitlist", { p_email: parsed.data.email, p_source: parsed.data.source || "site", p_ip_hash: hash }));
    if (error) {
      console.error("add_to_waitlist failed:", error.message);
      return reply({ error: "We couldn't save that. Try again." }, 500, cors);
    }
    return reply({ ok: true, new: data === true }, 200, cors);
  } catch (e) {
    console.error("Waitlist failed:", e instanceof Error ? e.message : e);
    return reply({ error: "We couldn't save that. Try again." }, 500, cors);
  }
}
