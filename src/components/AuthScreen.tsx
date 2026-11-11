"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { friendlyError } from "@/lib/friendlyError";
import { fmtNum } from "@/lib/format";
import { isSignup } from "@/lib/signin";
import { track } from "@/lib/track";
import { GoogleButton } from "./GoogleButton";
import { GoogleIcon } from "./Icons";
import { Loader } from "./Loader";
import { Lockup } from "./Logo";
import { Button, ErrorNote, Field, Input } from "./ui";

// The sign-in screen (docs/m0-plan.md section 3.1): a 6-digit code by email (no passwords), plus Google. One screen
// for everyone: a first sign-in makes the account. Navy page, the reverse lockup, one white square panel.

const RESEND_AFTER = 30;

// A stuck request never leaves the button busy for good.
function withTimeout<T>(p: PromiseLike<T>, ms = 20_000): Promise<T> {
  return Promise.race([Promise.resolve(p), new Promise<T>((_, reject) => setTimeout(() => reject(new Error("That took too long. Check your connection and try again.")), ms))]);
}

/** Where the email link and Google bring people back: this screen, keeping ?next=, which then opens the app. */
function returnUrl() {
  const next = new URLSearchParams(window.location.search).get("next");
  return `${window.location.origin}/signin${next ? `?next=${encodeURIComponent(next)}` : ""}`;
}

export function AuthFrame({ children }: { children?: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-shell px-4 py-12">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 flex justify-center">
          <Lockup size={32} tone="reverse" />
        </div>
        {children}
      </div>
    </main>
  );
}

function Terms() {
  return (
    <p className="on-dark mt-6 text-center text-[12px] leading-4 text-dim">
      By continuing you agree to the{" "}
      <a className="underline underline-offset-2 transition-colors duration-[var(--dur-hover)] hover:text-white" href="https://pulsearr.com/terms" target="_blank" rel="noopener noreferrer">
        Terms
      </a>{" "}
      and{" "}
      <a className="underline underline-offset-2 transition-colors duration-[var(--dur-hover)] hover:text-white" href="https://pulsearr.com/privacy" target="_blank" rel="noopener noreferrer">
        Privacy Policy
      </a>
      .
    </p>
  );
}

const textLink = "rounded-xs text-[13px] font-medium text-brand transition-colors duration-[var(--dur-hover)] hover:text-brand-hover disabled:pointer-events-none disabled:font-normal disabled:text-muted";

export function AuthScreen({ sb, googleClientId, initialError = "" }: { sb: SupabaseClient; googleClientId: string | null; initialError?: string }) {
  // A sign-up form on the website sends the email along (/signup?email=...).
  const [email, setEmail] = useState(() => (typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("email") ?? "").trim().slice(0, 254)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [sentTo, setSentTo] = useState("");
  const [wait, setWait] = useState(0);
  const [code, setCode] = useState("");
  const [signup] = useState(() => typeof window !== "undefined" && isSignup(window.location.pathname));

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function sendCode(to: string) {
    setBusy(true);
    setError("");
    try {
      const { error } = await withTimeout(sb.auth.signInWithOtp({ email: to, options: { emailRedirectTo: returnUrl() } }));
      if (error) throw error;
      setSentTo(to);
      setCode("");
      setWait(RESEND_AFTER);
      void track("signin_code_sent");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  // The code from the email, for when the link opens in another browser or a mail scanner used it up.
  async function verify(raw: string) {
    const token = raw.replace(/\D/g, "");
    if (token.length < 6 || busy) return;
    setBusy(true);
    setError("");
    try {
      const { error } = await withTimeout(sb.auth.verifyOtp({ email: sentTo, token, type: "email" }));
      if (error) throw error;
      void track("signin_code_used");
      // The page moves on when the session starts; the button stays busy until then.
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  }

  async function googleRedirect() {
    setBusy(true);
    setError("");
    void track("signin_started", { method: "google" });
    try {
      const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: returnUrl() } });
      if (error) throw error;
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  }

  const other = (() => {
    if (typeof window === "undefined") return signup ? "/signin" : "/signup";
    const q = new URLSearchParams(window.location.search);
    q.delete("email");
    const s = q.toString();
    return `${signup ? "/signin" : "/signup"}${s ? `?${s}` : ""}`;
  })();

  if (sentTo) {
    return (
      <AuthFrame>
        <div className="space-y-6 bg-panel p-8 max-sm:px-6">
          <div>
            <h1 className="font-serif text-[24px] leading-[30px] font-medium">Check your email</h1>
            <p className="mt-2 text-[14px] text-muted">
              We sent a code to <span className="font-medium wrap-anywhere text-ink">{sentTo}</span>.
            </p>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void verify(code);
            }}
            className="space-y-4"
          >
            <Field label="Code">
              <input
                autoFocus
                value={code}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                  setCode(v);
                  if (v.length === 6) void verify(v);
                }}
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="Code"
                className="h-12 w-full rounded-md border border-line bg-panel px-3 text-center font-serif text-[24px] font-medium tracking-[0.3em] text-ink tabular-nums outline-none transition-[border-color,box-shadow] duration-[var(--dur-hover)] focus:border-brand focus:shadow-focus"
              />
            </Field>
            <Button type="submit" className="w-full" disabled={busy || code.length < 6}>
              {busy ? <Loader size={4} className="text-white" /> : null}
              Sign in
            </Button>
          </form>
          <ErrorNote message={error} />
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <button
              type="button"
              className="rounded-xs text-[13px] text-muted transition-colors duration-[var(--dur-hover)] hover:text-ink"
              onClick={() => {
                setSentTo("");
                setError("");
                setBusy(false);
              }}
            >
              Use a different email
            </button>
            <button type="button" className={textLink} disabled={busy || wait > 0} onClick={() => void sendCode(sentTo)}>
              {wait > 0 ? `Send again in ${fmtNum(wait)}s` : "Send again"}
            </button>
          </div>
        </div>
        <Terms />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <div className="space-y-6 bg-panel p-8 max-sm:px-6">
        <h1 className="font-serif text-[24px] leading-[30px] font-medium">{signup ? "Create your account" : "Sign in to PulseARR"}</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const to = email.trim();
            if (!to) return;
            void track("signin_started", { method: "email" });
            void sendCode(to);
          }}
          className="space-y-4"
        >
          <Field label="Work email">
            <Input type="email" autoComplete="email" autoFocus required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Work email" />
          </Field>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader size={4} className="text-white" /> : null}
            Continue with email
          </Button>
        </form>
        <div className="flex items-center gap-3 text-[12px] text-muted" aria-hidden="true">
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
        </div>
        {googleClientId ? (
          <GoogleButton sb={sb} clientId={googleClientId} onStart={() => void track("signin_started", { method: "google" })} onError={(m) => setError(friendlyError(m))} />
        ) : (
          <Button type="button" variant="secondary" className="w-full" disabled={busy} onClick={() => void googleRedirect()}>
            <GoogleIcon size={16} />
            Continue with Google
          </Button>
        )}
        <ErrorNote message={error} />
        <p className="text-[13px] text-muted">
          {signup ? "Have an account? " : "New to PulseARR? "}
          <a href={other} className={textLink}>
            {signup ? "Sign in" : "Create an account"}
          </a>
        </p>
      </div>
      <Terms />
    </AuthFrame>
  );
}
