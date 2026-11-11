// The one place PulseARR sends email: Resend's API, tried again after a hiccup, with an idempotency key so a retry
// never sends twice. Without RESEND_API_KEY it does nothing outside production (and says so in the log), and fails
// in production. Templates follow docs/brand.md section 16: navy header strip, one serif line, one button, plain
// text always included.

import { appUrl as defaultAppUrl, emailFrom, isProduction, resendApiKey } from "./env.ts";
import { fetchWithRetry, type RetryOptions } from "./retry.ts";

const RESEND = "https://api.resend.com/emails";

export type Email = {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** The same key within 24 hours sends once (Resend keeps it). Use the record the email is about. */
  idempotencyKey?: string;
  from?: string;
};

export type SendResult = { id: string; skipped?: false } | { skipped: true };

/** Resend refused the email. `retry` is false when trying again can't help (a bad address, a bad key). */
export class EmailError extends Error {
  status: number;
  retry: boolean;
  constructor(message: string, status: number, retry: boolean) {
    super(message);
    this.name = "EmailError";
    this.status = status;
    this.retry = retry;
  }
}

export type SendDeps = { fetch?: typeof fetch; apiKey?: string; retry?: RetryOptions };

/** Text made safe to put inside HTML. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function sendEmail(email: Email, deps: SendDeps = {}): Promise<SendResult> {
  const key = deps.apiKey ?? resendApiKey();
  if (!key) {
    if (isProduction()) throw new EmailError("RESEND_API_KEY is not set", 0, true);
    console.info(`Email skipped (no RESEND_API_KEY): "${email.subject}" to ${[email.to].flat().join(", ")}`);
    return { skipped: true };
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  if (email.idempotencyKey) headers["Idempotency-Key"] = email.idempotencyKey.slice(0, 256);
  const body = JSON.stringify({
    from: email.from ?? emailFrom(),
    to: [email.to].flat(),
    subject: email.subject,
    html: email.html,
    text: email.text,
    ...(email.replyTo ? { reply_to: email.replyTo } : {}),
  });
  let res: Response;
  try {
    res = await fetchWithRetry(RESEND, { method: "POST", headers, body }, { timeoutMs: 10_000, fetch: deps.fetch, ...deps.retry });
  } catch (e) {
    throw new EmailError(`Resend didn't answer: ${e instanceof Error ? e.message : String(e)}`, 0, true);
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  if (!res.ok) {
    const busy = res.status === 429 || res.status === 408 || res.status >= 500;
    throw new EmailError(`Resend answered ${res.status}: ${data.message ?? data.name ?? "no message"}`, res.status, busy);
  }
  return { id: data.id ?? "" };
}

// Brand colors (docs/brand-tokens.css). Email clients can't read CSS variables, so the values are written here.
const C = { navyDeep: "#000522", ink: "#0E0E0E", muted: "#5D6275", blue: "#131FA7", line: "#E4E6EE", white: "#FFFFFF" };
const SERIF = "Newsreader, 'Source Serif 4', Georgia, serif";
const SANS = "Inter, Arial, sans-serif";

/** The shared frame: navy header strip with the name, an eyebrow, one serif line, short lines, one button. */
export function layout(o: { eyebrow: string; title: string; lines: string[]; button: { label: string; url: string }; footer?: string }): string {
  const lines = o.lines.map((l) => `<p style="margin:0 0 12px;font:400 15px/22px ${SANS};color:${C.ink}">${esc(l)}</p>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:${C.white}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.white}"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">
<tr><td style="background:${C.navyDeep};padding:20px 32px;font:500 20px/24px ${SERIF};color:${C.white}">PulseARR</td></tr>
<tr><td style="padding:32px 32px 8px">
<p style="margin:0 0 12px;font:500 11px/14px ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${C.blue}">${esc(o.eyebrow)}</p>
<h1 style="margin:0 0 16px;font:500 28px/32px ${SERIF};color:${C.ink}">${esc(o.title)}</h1>
${lines}
<p style="margin:20px 0 24px"><a href="${esc(o.button.url)}" style="display:inline-block;background:${C.blue};color:${C.white};font:500 15px/20px ${SANS};padding:12px 20px;border-radius:8px;text-decoration:none">${esc(o.button.label)}</a></p>
</td></tr>
${o.footer ? `<tr><td style="padding:16px 32px 32px;border-top:1px solid ${C.line};font:400 12px/16px ${SANS};color:${C.muted}">${esc(o.footer)}</td></tr>` : ""}
</table></td></tr></table>
</body></html>`;
}

/** The invite to join a workspace. The invitee joins by signing in with the address it was sent to. */
export function inviteEmail(o: { workspaceName: string; inviterEmail: string | null; appUrl?: string }): { subject: string; html: string; text: string } {
  const ws = o.workspaceName.trim() || "a workspace";
  const who = o.inviterEmail?.trim() || "Someone on your team";
  const url = `${(o.appUrl ?? defaultAppUrl()).replace(/\/+$/, "")}/signin`;
  const title = `Join ${ws} on PulseARR`;
  const lines = [`${who} invited you to the ${ws} workspace.`, "Sign in with this email address to join."];
  const footer = "If you weren't expecting this invite, you can ignore this email.";
  const button = { label: `Join ${ws}`, url };
  return {
    subject: title,
    html: layout({ eyebrow: "Team invite", title, lines, button, footer }),
    text: [title, "", ...lines, "", `${button.label}: ${url}`, "", footer].join("\n"),
  };
}
