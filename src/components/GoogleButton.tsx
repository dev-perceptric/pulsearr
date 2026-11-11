"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useRef } from "react";

// Google's own sign-in button (Google Identity Services). Google shows PulseARR's name on its screen, where the
// redirect sign-in shows the database address. GoTrue checks the token and starts the session.

type Gis = {
  accounts: {
    id: {
      initialize(options: { client_id: string; nonce: string; callback: (res: { credential: string }) => void; use_fedcm_for_button?: boolean }): void;
      renderButton(el: HTMLElement, options: Record<string, unknown>): void;
    };
  };
};

const SCRIPT = "https://accounts.google.com/gsi/client";

function loadGis(): Promise<Gis> {
  const w = window as unknown as { google?: Gis };
  if (w.google?.accounts) return Promise.resolve(w.google);
  return new Promise((resolve, reject) => {
    let tag = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT}"]`);
    if (!tag) {
      tag = document.createElement("script");
      tag.src = SCRIPT;
      tag.async = true;
      document.head.appendChild(tag);
    }
    tag.addEventListener("load", () => (w.google ? resolve(w.google) : reject(new Error("Google sign-in didn't load."))));
    tag.addEventListener("error", () => reject(new Error("Google sign-in didn't load. Check your connection or ad blocker.")));
  });
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function GoogleButton({ sb, clientId, onError, onStart }: { sb: SupabaseClient; clientId: string; onError: (message: string) => void; onStart?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onError, onStart });
  useEffect(() => {
    handlers.current = { onError, onStart };
  });

  useEffect(() => {
    let live = true;
    // Google gets the hashed nonce. GoTrue gets the raw one and checks they match, so a stolen token can't be replayed.
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
    Promise.all([loadGis(), sha256Hex(nonce)])
      .then(([gis, hashed]) => {
        if (!live || !box.current) return;
        gis.accounts.id.initialize({
          client_id: clientId,
          nonce: hashed,
          use_fedcm_for_button: true,
          callback: async ({ credential }) => {
            handlers.current.onStart?.();
            const { error } = await sb.auth.signInWithIdToken({ provider: "google", token: credential, nonce });
            if (error) handlers.current.onError(error.message);
          },
        });
        gis.accounts.id.renderButton(box.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          logo_alignment: "center",
          // The app is in English; Google would follow the browser's language.
          locale: "en",
          width: Math.min(400, box.current.offsetWidth),
        });
      })
      .catch((e) => live && handlers.current.onError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [sb, clientId]);

  return <div ref={box} className="flex min-h-10 w-full justify-center" />;
}
