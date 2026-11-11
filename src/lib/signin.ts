// Where the sign-in screen lives and where people go after it. Signed out, any app address shows /signin (or /signup,
// from "Start free" links), keeping a deep link in ?next= and any other query (utm_*) as it was. Signed in, /signin
// and /signup open `next`, or the app's home. Pure, so it's tested without a browser.

export const AUTH_PATHS = new Set(["/signin", "/signup"]);
export const HOME = "/dashboard";
// Addresses that only mean "open the app": no need to come back to them after signing in.
const HOME_PATHS = new Set(["", "/", HOME, "/signin", "/signup"]);

/** The address to show a signed-out visitor who opened `path` with `search` (like "?utm_source=blog"). */
export function authUrl(path: string, search: string): string {
  if (AUTH_PATHS.has(path)) return `${path}${search}`;
  if (HOME_PATHS.has(path)) return `/signin${search}`;
  return `/signin?next=${encodeURIComponent(`${path}${search}`)}`;
}

/** Where to go once signed in: a safe `next` on this site, else home. */
export function afterSignin(search: string): string {
  const next = new URLSearchParams(search).get("next") ?? "";
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || /[\r\n\t]/.test(next)) return HOME;
  const path = next.split(/[?#]/)[0] ?? "";
  if (AUTH_PATHS.has(path)) return HOME;
  return next;
}

/** Whether this address asks to make an account, so the screen says so. */
export const isSignup = (path: string) => path === "/signup";
