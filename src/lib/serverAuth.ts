import "server-only";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { supabasePublishableKey, supabaseSecretKey, supabaseUrl } from "./env.ts";
import { retryResult } from "./retry.ts";

// Who a token belongs to and which workspaces they're in, remembered for 30 seconds in this server process, so each
// API call doesn't pay two extra round trips. A token past its own expiry is never reused. The real cause of a
// failure goes to the log; the route sends one plain line (HttpError).

const TTL = 30_000;
const users = new Map<string, { user: User; until: number }>();
const members = new Map<string, { admin: boolean | null; until: number }>();
const prune = <T>(m: Map<string, T>) => {
  if (m.size > 2000) m.clear();
};
const expiryOf = (token: string) => {
  try {
    return Number(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()).exp) * 1000 || 0;
  } catch {
    return 0;
  }
};

/** A failure to send back as it is: a status and one plain line. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** The answer for an error thrown in a route: an HttpError as it is, anything else logged and sent as one line. */
export function errorResponse(e: unknown, headers?: HeadersInit): Response {
  if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status, headers });
  console.error(e);
  return Response.json({ error: "Something went wrong. Try again." }, { status: 500, headers });
}

const notSetUp = (what: string) => {
  console.error(`Server setup: ${what} is missing`);
  return new HttpError(500, "The server isn't set up yet.");
};

/** Clear the 30-second memory (tests). */
export function forgetAuth() {
  users.clear();
  members.clear();
}

export type Caller = { sb: SupabaseClient; user: User; userId: string; token: string };

/** Check the request carries a signed-in session. Returns a Supabase client that acts as the caller. */
export async function requireUser(request: Request): Promise<Caller> {
  const url = supabaseUrl();
  const key = supabasePublishableKey();
  if (!url || !key) throw notSetUp("SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY");
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Please sign in again.");

  const sb = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const now = Date.now();
  let known = users.get(token);
  if (!known || known.until < now) {
    const { data, error } = await sb.auth.getUser(token);
    if (!data?.user) {
      // A missing user is a signed-out caller; a network or server failure is ours to report.
      const status = (error as { status?: number } | null)?.status ?? 401;
      if (error && (status >= 500 || !status)) {
        console.error("Auth check failed:", error.message);
        throw new HttpError(503, "We couldn't check your sign-in. Try again.");
      }
      throw new HttpError(401, "Please sign in again.");
    }
    const exp = expiryOf(token);
    prune(users);
    known = { user: data.user, until: Math.min(now + TTL, exp || now + TTL) };
    users.set(token, known);
  }
  return { sb, user: known.user, userId: known.user.id, token };
}

async function ask(sb: SupabaseClient, fn: "is_member" | "is_admin", ws: string): Promise<boolean> {
  const { data, error } = await retryResult(() => sb.rpc(fn, { ws }), { tries: 3, baseMs: 200 });
  if (error) {
    console.error(`${fn} failed:`, error.message);
    throw new HttpError(503, "We couldn't check your workspace. Try again.");
  }
  return data === true;
}

/**
 * Check the caller is signed in and belongs to the workspace: is_member(ws), or with `admin`, is_admin(ws) (an
 * owner or admin). `admin` in the answer is null when it wasn't checked.
 */
export async function requireMember(request: Request, workspaceId: unknown, opts: { admin?: boolean } = {}): Promise<Caller & { admin: boolean | null }> {
  if (typeof workspaceId !== "string" || !/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new HttpError(400, "Missing workspace.");
  const caller = await requireUser(request);
  const now = Date.now();
  const memberKey = `${caller.userId}:${workspaceId}`;
  let known = members.get(memberKey);
  if (!known || known.until < now || (opts.admin && known.admin === null)) {
    if (!(await ask(caller.sb, "is_member", workspaceId))) throw new HttpError(403, "You are not in this workspace.");
    const admin = opts.admin ? await ask(caller.sb, "is_admin", workspaceId) : null;
    prune(members);
    known = { admin, until: Math.min(now + TTL, users.get(caller.token)?.until ?? now + TTL) };
    members.set(memberKey, known);
  }
  if (opts.admin && !known.admin) throw new HttpError(403, "Only owners and admins can do this.");
  return { ...caller, admin: known.admin };
}

/** A Supabase client with full access (SUPABASE_SECRET_KEY). Server only. */
export function adminClient(): SupabaseClient {
  const url = supabaseUrl();
  const key = supabaseSecretKey();
  if (!url || !key) throw notSetUp("SUPABASE_URL or SUPABASE_SECRET_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
