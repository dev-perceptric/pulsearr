import type { SupabaseClient } from "@supabase/supabase-js";
import { plainError } from "../lib/plainError.ts";
import { isHiccup, retryResult } from "../lib/retry.ts";

// One write through a checked database function (004_team.sql), with hiccups tried again (src/lib/retry.ts). What's
// left is either a hiccup that outlasted the retries (the screen offers Retry) or the function's own plain line
// ("Already on the team"), which the screen shows as it is. A technical message never reaches the screen.

export type WriteResult<T> = { ok: true; data: T } | { ok: false; hiccup: boolean; message: string };

export async function rpcWrite<T = unknown>(sb: Pick<SupabaseClient, "rpc">, fn: string, args: Record<string, unknown>, o: { baseMs?: number } = {}): Promise<WriteResult<T>> {
  try {
    const res = await retryResult(() => sb.rpc(fn, args), { baseMs: o.baseMs });
    if (!res.error) return { ok: true, data: res.data as T };
    const status = (res as { status?: number }).status;
    const hiccup = isHiccup(res.error) || status === 429 || (typeof status === "number" && status >= 500);
    return { ok: false, hiccup, message: hiccup ? "Couldn't reach PulseARR. Try again." : plainError(res.error) };
  } catch (e) {
    // The network never answered.
    return { ok: false, hiccup: true, message: plainError(e, "Couldn't reach PulseARR. Try again.") };
  }
}
