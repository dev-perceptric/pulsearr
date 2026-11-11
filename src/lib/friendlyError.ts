// One short, plain line for a sign-in error a person sees. Database, setup and network messages never reach the
// screen as they are.

const SETUP = /migration|supabase|schema|function .* does not exist|could not find the function|PGRST|relation .* does not exist|column .* does not exist|permission denied|violates|syntax error/i;

export function friendlyError(e: unknown, fallback = "Something went wrong. Try again."): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "";
  const text = raw.trim();
  if (!text) return fallback;
  if (/rate limit|too many/i.test(text)) return "Too many tries in a short time. Wait a minute and try again.";
  if (/fetch|network|timed? ?out|took too long|load failed|ECONN/i.test(text)) return "We couldn't reach the server. Check your connection and try again.";
  if (/token has expired|otp.*expired|invalid.*(token|otp)|expired or is invalid/i.test(text)) return "That code didn't work. Check it or send a new one.";
  if (/provider is not enabled/i.test(text)) return "This sign-in option isn't turned on yet. Use email for now.";
  if (/signups? not allowed/i.test(text)) return "Sign-ups are closed for this address.";
  if (/invalid email|email.*invalid|doesn't look right/i.test(text)) return "That email doesn't look right.";
  if (SETUP.test(text) || text.length > 140) return fallback;
  return text;
}
