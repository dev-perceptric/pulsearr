// Settings from the environment, read when asked (never at import), trimmed, so a pasted value with a stray space
// or line break still works. setupReport() says which are present, never what they are.

export const ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "DATABASE_URL",
  "SECRETS_KEY",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "ANTHROPIC_API_KEY",
  "APP_URL",
  "SITE_ORIGINS",
  "NEXT_PUBLIC_POSTHOG_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_APP_CLIENT_ID",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
] as const;

export type EnvName = (typeof ENV_NAMES)[number];

/** The value, trimmed, or "" when it isn't set. */
export const envVar = (name: EnvName | string): string => process.env[name]?.trim() ?? "";

export const isProduction = () => process.env.NODE_ENV === "production";

const noTrailingSlash = (s: string) => s.replace(/\/+$/, "");

export const supabaseUrl = () => noTrailingSlash(envVar("SUPABASE_URL"));
export const supabasePublishableKey = () => envVar("SUPABASE_PUBLISHABLE_KEY");
export const supabaseSecretKey = () => envVar("SUPABASE_SECRET_KEY");
export const databaseUrl = () => envVar("DATABASE_URL");
export const secretsKey = () => envVar("SECRETS_KEY");
export const resendApiKey = () => envVar("RESEND_API_KEY");
export const emailFrom = () => envVar("EMAIL_FROM") || "Pulse at PulseARR <pulse@pulsearr.com>";
export const anthropicApiKey = () => envVar("ANTHROPIC_API_KEY");
/** The app's own address, like https://app.pulsearr.com, without a trailing slash. */
export const appUrl = () => noTrailingSlash(envVar("APP_URL")) || (isProduction() ? "https://app.pulsearr.com" : "http://localhost:3000");
/** Websites allowed to post to the public API (the waitlist form), as origins like https://pulsearr.com. */
export const siteOrigins = (): string[] =>
  envVar("SITE_ORIGINS")
    .split(/[\s,]+/)
    .map((o) => noTrailingSlash(o.trim()))
    .filter(Boolean);
export const posthogKey = () => envVar("NEXT_PUBLIC_POSTHOG_KEY");
/** The platform's Stripe secret key: trades install codes for tokens and refreshes them (web app and worker). */
export const stripeSecretKey = () => envVar("STRIPE_SECRET_KEY");
/** The PulseARR Stripe App's client id (ca_...), for the install page. */
export const stripeAppClientId = () => envVar("STRIPE_APP_CLIENT_ID");
/** The signing secret of the Connect webhook at /api/stripe/webhook (whsec_...). */
export const stripeWebhookSecret = () => envVar("STRIPE_CONNECT_WEBHOOK_SECRET");

/** Which settings are present. Booleans only: safe to show on /api/health/setup. */
export function setupReport(): Record<EnvName, boolean> {
  return Object.fromEntries(ENV_NAMES.map((n) => [n, envVar(n) !== ""])) as Record<EnvName, boolean>;
}
