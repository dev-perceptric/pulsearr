"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { afterSignin } from "@/lib/signin";
import { browserClient } from "@/lib/supa";
import { AuthFrame, AuthScreen } from "./AuthScreen";

// /signin and /signup. Signed in already (or back from the email link or Google), it opens `next` or the dashboard.
// The page reads the settings on the server and passes them in (src/app/(auth)/*/page.tsx).

export type ClientConfig = { url: string; key: string; googleClientId: string | null };

const LINK_FAILED = "That link didn't open here. Type the code from the email instead.";

export function AuthPage({ config }: { config: ClientConfig }) {
  const router = useRouter();
  const sb = useMemo(() => browserClient(config.url, config.key), [config.url, config.key]);
  const [state, setState] = useState<{ ready: boolean; error: string }>({ ready: false, error: "" });

  useEffect(() => {
    let live = true;
    const go = () => router.replace(afterSignin(window.location.search));
    // getSession waits for the client to finish reading the address, so a link's code is exchanged first.
    sb.auth
      .getSession()
      .then(({ data }) => {
        if (!live) return;
        if (data.session) return go();
        const url = new URL(window.location.href);
        const failed = url.searchParams.has("code") || url.searchParams.has("error_description") || url.hash.includes("error");
        for (const p of ["code", "error", "error_code", "error_description"]) url.searchParams.delete(p);
        if (failed) window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
        setState({ ready: true, error: failed ? LINK_FAILED : "" });
      })
      .catch(() => live && setState({ ready: true, error: "" }));
    const { data } = sb.auth.onAuthStateChange((event, session) => {
      if (session && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) go();
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, [sb, router]);

  if (!state.ready) return <AuthFrame />;
  return <AuthScreen sb={sb} googleClientId={config.googleClientId} initialError={state.error} />;
}

/** When the server is missing its settings: one plain line. The cause shows on /api/health/setup. */
export function NotReady() {
  return (
    <AuthFrame>
      <div role="alert" className="space-y-2 bg-panel p-8 max-sm:px-6">
        <h1 className="font-serif text-[24px] leading-[30px] font-medium">PulseARR can&apos;t open right now</h1>
        <p className="text-[14px] text-muted">Try again in a few minutes.</p>
      </div>
    </AuthFrame>
  );
}
