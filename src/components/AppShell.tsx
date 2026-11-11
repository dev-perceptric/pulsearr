"use client";

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { plainError } from "@/lib/plainError";
import { retryResult } from "@/lib/retry";
import { authUrl } from "@/lib/signin";
import { browserClient } from "@/lib/supa";
import type { ClientConfig } from "./AuthPage";
import { DialogHost } from "./Dialogs";
import { Floating } from "./Floating";
import { ChevronsUpDown, LayoutDashboard, LogOut, Menu, Settings, UserIcon } from "./Icons";
import { Lockup } from "./Logo";
import { Sheet } from "./Overlay";
import { PageBoundary } from "./PageBoundary";
import { Select } from "./Select";
import { forgetBoot, navOf, parseBoot, readBoot, readPref, sameBoot, saveBoot, savePref, type Boot, type Store, type WorkspaceRef } from "./shellState";
import { UndoHost } from "./Undo";
import { AppCtx, Avatar, Button, clearScreens, IconButton, Loading, setTokenSource } from "./ui";

// The signed-in app around every page (docs/brand.md section 12, Shell): the navy sidebar with the logo, Dashboard,
// Settings, the workspace switcher and the account menu, and the white work area. One boot() call says who you are and
// which workspaces you're in; the last answer is kept per person, so a reload draws the shell at once and the fresh
// answer swaps in when it lands. Signed out, any page goes to /signin?next=<where you were>.

export type Shell = {
  sb: SupabaseClient;
  user: { id: string; email: string | null };
  workspace: WorkspaceRef;
  workspaces: WorkspaceRef[];
  /** Open another workspace you're in. */
  switchWorkspace: (id: string) => void;
  /** Ask boot() again (after a rename, a delete or leaving). Throws when it still fails after retrying. */
  refreshBoot: () => Promise<void>;
  signOut: () => Promise<void>;
};

const ShellCtx = createContext<Shell | null>(null);

/** The signed-in shell, for any page inside the app. */
export function useShell(): Shell {
  const s = useContext(ShellCtx);
  if (!s) throw new Error("useShell is only for pages inside AppShell");
  return s;
}

const store = (): Store => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** Runs `fn` with PostHog when it's on (instrumentation-client.ts loads it in the background); nothing otherwise. */
const analytics = async (fn: (ph: (typeof import("posthog-js"))["default"]) => unknown) => {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
  try {
    const { default: ph } = await import("posthog-js");
    if (ph.__loaded) await fn(ph);
  } catch {}
};

const NAV = [
  { id: "dashboard", href: "/dashboard", label: "Dashboard", icon: <LayoutDashboard size={20} /> },
  { id: "settings", href: "/settings/workspace", label: "Settings", icon: <Settings size={20} /> },
] as const;

const SCREEN_NAMES: Record<string, string> = { dashboard: "Dashboard", settings: "Settings" };

export function AppShell({ config, children }: { config: ClientConfig; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const sb = useMemo(() => browserClient(config.url, config.key), [config.url, config.key]);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [boot, setBoot] = useState<Boot | null>(null);
  const [bootError, setBootError] = useState("");
  const [bootRun, setBootRun] = useState(0);
  const [menu, setMenu] = useState(false);
  // Signing out on purpose goes to /signin without a ?next=.
  const [leaving, setLeaving] = useState(false);

  // postJson and postStream read the bearer token from here.
  useEffect(() => {
    setTokenSource(async () => (await sb.auth.getSession()).data.session?.access_token ?? null);
  }, [sb]);

  useEffect(() => {
    let live = true;
    sb.auth
      .getSession()
      .then(({ data }) => {
        if (!live) return;
        // The last boot draws the shell at once; the fresh one replaces it when it lands.
        const last = data.session ? readBoot(store(), data.session.user.id) : null;
        if (last) setBoot(last);
        setSession(data.session);
      })
      .catch(() => live && setSession(null));
    const { data } = sb.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "SIGNED_OUT") {
        clearScreens();
        forgetBoot(store());
        setBoot(null);
        void analytics((ph) => ph.reset());
      }
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, [sb]);

  // Signed out: the sign-in screen, keeping where you were in ?next=.
  useEffect(() => {
    if (session !== null || leaving) return;
    router.replace(authUrl(window.location.pathname, window.location.search));
  }, [session, leaving, router]);

  const userId = session?.user.id;

  /** boot(): the last workspace you picked on this browser if you're still in it, else boot's own pick. */
  const fetchBoot = useCallback(async (): Promise<Boot> => {
    const pref = readPref(store());
    let res = await retryResult(() => sb.rpc("boot", pref ? { p_pref: pref } : {}));
    // A stored pick the server won't take never blocks the app: ask without it.
    if (res.error && pref && !/not signed in/i.test(res.error.message)) res = await retryResult(() => sb.rpc("boot", {}));
    if (res.error) throw res.error;
    const b = parseBoot(res.data);
    if (!b?.workspace) throw new Error("Couldn't open your workspace. Try again.");
    return b;
  }, [sb]);

  const applyBoot = useCallback((b: Boot) => {
    setBoot((prev) => (sameBoot(prev, b) ? prev : b));
    setBootError("");
    saveBoot(store(), b);
    if (b.workspace) savePref(store(), b.workspace.id);
    // Who this is in PostHog: the person's id only, with their workspace on every event.
    void analytics((ph) => {
      ph.identify(b.user.id);
      if (b.workspace) ph.register({ workspace_id: b.workspace.id });
    });
  }, []);

  useEffect(() => {
    if (!userId) return;
    let live = true;
    const drawn = Boolean(readBoot(store(), userId));
    fetchBoot()
      .then((b) => live && applyBoot(b))
      .catch((e: unknown) => {
        if (!live) return;
        // With the last copy on screen, a failed refresh stays quiet; the next load tries again.
        if (drawn) console.warn("boot:", e instanceof Error ? e.message : e);
        else setBootError(plainError(e, "Couldn't open your workspace. Try again."));
      });
    return () => {
      live = false;
    };
  }, [userId, bootRun, fetchBoot, applyBoot]);

  const refreshBoot = useCallback(async () => applyBoot(await fetchBoot()), [fetchBoot, applyBoot]);

  const switchWorkspace = useCallback(
    (id: string) => {
      savePref(store(), id);
      clearScreens();
      setBoot((b) => {
        const w = b?.workspaces.find((x) => x.id === id);
        return b && w ? { ...b, workspace: w } : b;
      });
      router.push("/dashboard");
      setBootRun((n) => n + 1);
    },
    [router],
  );

  const signOut = useCallback(async () => {
    setLeaving(true);
    const { error } = await sb.auth.signOut();
    // Offline, the session still ends on this browser.
    if (error) await sb.auth.signOut({ scope: "local" });
    forgetBoot(store());
    clearScreens();
    router.replace("/signin");
  }, [sb, router]);

  const ready = session && boot?.workspace && boot.user.id === session.user.id ? boot : null;
  const shell = useMemo<Shell | null>(
    () => (ready?.workspace ? { sb, user: ready.user, workspace: ready.workspace, workspaces: ready.workspaces, switchWorkspace, refreshBoot, signOut } : null),
    [sb, ready, switchWorkspace, refreshBoot, signOut],
  );
  const appInfo = useMemo(
    () => (shell ? { workspace: { id: shell.workspace.id, name: shell.workspace.name }, user: shell.user, role: shell.workspace.role, navigate: (p: string) => router.push(p) } : null),
    [shell, router],
  );

  const picked = navOf(pathname);
  const side = <SideNav shell={shell} picked={picked} onPick={() => setMenu(false)} />;

  return (
    <>
      <div className="flex h-dvh flex-col bg-panel md:flex-row">
        <aside className="on-dark hidden w-[var(--sidebar-width)] shrink-0 flex-col bg-shell md:flex">{side}</aside>
        <header className="on-dark flex min-h-14 shrink-0 items-center justify-between gap-3 bg-shell pr-2 pl-4 md:hidden">
          <Link href="/dashboard" className="rounded-xs" aria-label="PulseARR home">
            <Lockup size={24} tone="reverse" />
          </Link>
          <IconButton label="Menu" variant="dark" align="end" onClick={() => setMenu(true)} aria-expanded={menu}>
            <Menu size={20} />
          </IconButton>
        </header>
        <Sheet open={menu} onClose={() => setMenu(false)} side="left" label="Menu" over>
          <div className="on-dark flex min-h-0 flex-1 flex-col overflow-y-auto bg-shell">{side}</div>
        </Sheet>
        <main className="min-h-0 min-w-0 flex-1 bg-panel">
          {shell && appInfo ? (
            <ShellCtx.Provider value={shell}>
              <AppCtx.Provider value={appInfo}>
                <PageBoundary name={SCREEN_NAMES[picked ?? ""] ?? "This page"} resetKey={`${shell.workspace.id}:${pathname}`}>
                  {children}
                </PageBoundary>
              </AppCtx.Provider>
            </ShellCtx.Provider>
          ) : bootError ? (
            <div className="flex h-full items-center justify-center p-6">
              <div role="alert" className="w-full max-w-md space-y-5 border border-line bg-panel p-6">
                <div>
                  <h1 className="font-serif text-[24px] leading-[30px] font-medium wrap-break-word">Couldn&apos;t open PulseARR</h1>
                  <p className="mt-1 text-[14px] wrap-break-word text-muted">{bootError}</p>
                </div>
                <Button
                  onClick={() => {
                    setBootError("");
                    setBootRun((n) => n + 1);
                  }}
                >
                  Retry
                </Button>
              </div>
            </div>
          ) : (
            <Loading />
          )}
        </main>
      </div>
      <DialogHost />
      <UndoHost />
    </>
  );
}

function SideNav({ shell, picked, onPick }: { shell: Shell | null; picked: "dashboard" | "settings" | null; onPick: () => void }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <div className="flex min-h-16 shrink-0 items-center px-5">
        <Link href="/dashboard" onClick={onPick} className="rounded-xs" aria-label="PulseARR home">
          <Lockup size={24} tone="reverse" />
        </Link>
      </div>
      <nav aria-label="Main" className="flex flex-col py-2">
        {NAV.map((n) => {
          const on = picked === n.id;
          return (
            <Link
              key={n.id}
              href={n.href}
              onClick={onPick}
              aria-current={on ? "page" : undefined}
              className={`relative flex min-h-10 items-center gap-3 px-5 py-2 text-[14px] text-white transition-colors duration-[var(--dur-hover)] ease-[var(--ease)] ${on ? "bg-slate before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-sky" : "hover:bg-slate-fade"}`}
            >
              {n.icon}
              {n.label}
            </Link>
          );
        })}
      </nav>
      {shell ? (
        <div className="mt-auto space-y-2 border-t border-slate p-3">
          {shell.workspaces.length > 1 ? (
            <Select
              ariaLabel="Workspace"
              value={shell.workspace.id}
              options={shell.workspaces.map((w) => ({ value: w.id, label: w.name }))}
              onChange={(id) => {
                onPick();
                shell.switchWorkspace(id);
              }}
              className="min-h-10 w-full rounded-md border border-slate bg-transparent px-3 text-[14px] text-white transition-colors duration-[var(--dur-hover)] hover:bg-slate-fade"
            />
          ) : (
            <p className="px-2 pt-1 text-[13px] leading-[18px] wrap-anywhere text-dim">{shell.workspace.name}</p>
          )}
          <AccountMenu shell={shell} onPick={onPick} />
        </div>
      ) : null}
    </div>
  );
}

function AccountMenu({ shell, onPick }: { shell: Shell; onPick: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  const email = shell.user.email ?? "";
  const item = "flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] text-ink transition-colors duration-[var(--dur-hover)] hover:bg-hover";
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${email}`}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-[18px] text-white transition-colors duration-[var(--dur-hover)] hover:bg-slate-fade"
      >
        <Avatar label={email || "?"} size={24} />
        <span className="min-w-0 flex-1 wrap-anywhere">{email}</span>
        <ChevronsUpDown size={14} className="text-dim" />
      </button>
      {open ? (
        <Floating anchor={ref} placement="top-start" matchWidth={200} onClose={() => setOpen(false)} role="menu" aria-label="Account" className="rounded-md border border-line bg-panel p-1 shadow-pop">
          <p className="px-2 py-1.5 text-[12px] leading-4 wrap-anywhere text-muted">{email}</p>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              onPick();
              router.push("/settings/account");
            }}
          >
            <UserIcon size={16} className="text-muted" />
            Account
          </button>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              onPick();
              void shell.signOut();
            }}
          >
            <LogOut size={16} className="text-muted" />
            Sign out
          </button>
        </Floating>
      ) : null}
    </>
  );
}
