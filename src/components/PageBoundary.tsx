"use client";

import { Component, type ReactNode } from "react";
import { Button, CopyButton } from "./ui";

// A crash in one screen stays in that screen. Open pages can stay loaded in the background, so without this a hidden
// page breaking would take down the whole app. The screen first retries once on its own; if a newer version of the app
// went live while the tab was open (`/api/version`), the page reloads instead, since old and new code don't mix. Every
// crash goes to the console with its component stack, and "Copy details" gives the same text to send to us.

const BUILD = process.env.NEXT_PUBLIC_BUILD ?? "";
const RELOADED = "pulsearr:reloaded";

/** Whether the server runs a newer build than this tab. At most one reload a minute, so it can never loop. */
export async function stale() {
  if (!BUILD) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOADED) ?? 0);
    if (Date.now() - last < 60_000) return false;
  } catch {}
  try {
    const r = await fetch("/api/version", { cache: "no-store" });
    const { build } = (await r.json()) as { build?: string };
    const old = Boolean(build) && build !== BUILD;
    if (old)
      try {
        sessionStorage.setItem(RELOADED, String(Date.now()));
      } catch {}
    return old;
  } catch {
    return false;
  }
}

type Props = { name: string; resetKey: string; children: ReactNode };
type State = { error: Error | null; tries: number; details: string };

export class PageBoundary extends Component<Props, State> {
  state: State = { error: null, tries: 0, details: "" };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    const details = [`${error.name}: ${error.message}`, `Screen: ${this.props.name} (${typeof window === "undefined" ? "" : window.location.pathname})`, `Build: ${BUILD || "unknown"}`, error.stack ?? "", info.componentStack ?? ""].join("\n").slice(0, 8000);
    this.setState({ details });
    console.error(details);
    void (async () => {
      if (await stale()) return window.location.reload();
      // One quiet retry: many crashes come from a moment's bad timing and don't happen twice.
      if (this.state.tries === 0) this.setState({ error: null, tries: 1 });
    })();
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && (this.state.error || this.state.tries)) this.setState({ error: null, tries: 0, details: "" });
  }

  render() {
    const { error, tries, details } = this.state;
    if (!error) return this.props.children;
    // The first time, the retry is on its way; show nothing rather than a flash of the error.
    if (tries === 0) return null;
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div role="alert" className="w-full max-w-md space-y-5 border border-line bg-panel p-6">
          <div>
            <h2 className="font-serif text-[24px] leading-[30px] font-medium wrap-break-word text-ink">{this.props.name} couldn&apos;t load</h2>
            <p className="mt-1 text-[14px] text-muted">The rest of PulseARR still works.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => window.location.reload()}>Reload</Button>
            <Button variant="secondary" onClick={() => this.setState({ error: null, tries: 1 })}>
              Try again
            </Button>
            <CopyButton text={details} label="Copy details" />
          </div>
        </div>
      </div>
    );
  }
}
