"use client";

import { useState } from "react";
import { plainError } from "@/lib/plainError";
import { useShell } from "./AppShell";
import { Loader } from "./Loader";
import { postRetry } from "./revenue";
import { notify } from "./Undo";
import { Button, type ButtonVariant } from "./ui";

// "Connect Stripe": asks our API for Stripe's approve page and goes there. Stripe sends the person back to
// /settings/sources (with ?error=<code> when it didn't work).
export function ConnectStripe({ variant = "primary", label = "Connect Stripe" }: { variant?: ButtonVariant; label?: string }) {
  const { workspace } = useShell();
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      const r = await postRetry<{ url?: unknown }>("/api/stripe/connect", { workspace_id: workspace.id });
      if (typeof r.url !== "string" || !/^https:\/\//.test(r.url)) throw new Error("Couldn't open Stripe. Try again.");
      // Stays busy until the browser leaves for Stripe.
      window.location.assign(r.url);
    } catch (e) {
      setBusy(false);
      notify(plainError(e, "Couldn't open Stripe. Try again."), { label: "Retry", run: () => void go() });
    }
  }

  return (
    <Button variant={variant} onClick={() => void go()} disabled={busy} aria-busy={busy}>
      {busy ? <Loader size={4} className={variant === "primary" ? "text-white" : "text-brand"} /> : null}
      {label}
    </Button>
  );
}
