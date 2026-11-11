"use client";

import { readStream } from "@/lib/streamed";
import { plainError } from "@/lib/plainError";
import { fmtAgo, fmtDateTime, fmtParts } from "@/lib/format";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type SetStateAction } from "react";
import { Check, Copy, SearchIcon } from "./Icons";
import { Drawing, type DrawingKind } from "./Drawing";
import { Tip, useTip } from "./Floating";
import { asked, remember, screenGen, seenData } from "./screenCache";

export { clearScreens, prefetch } from "./screenCache";

// PulseARR's shared parts (docs/brand.md section 12). Square cards and panels with a 1px line, 8px corners on
// buttons, inputs, menus and dialogs, 2px tags, serif page titles and big numbers, pulse blue for the one primary
// action. Screens use these and never a local copy.

/** Goes up each time a kept page is shown again, so its data refreshes while what you typed stays. */
export const PageShown = createContext(0);

/**
 * A screen's tabs with their own address: `/settings/team`. Back, refresh and shared links open the same tab.
 * `base` is the screen's own path without a tab (null keeps the tab in the screen only, as in a side panel). The
 * first tab has no segment. A kept page that's shown again reads its tab from the address.
 */
export function useAddressTab<T extends string>(base: string | null, tabs: readonly T[], first: T): [T, (t: T) => void] {
  const read = (): T => {
    if (!base || typeof window === "undefined") return first;
    const path = window.location.pathname;
    const seg = path.startsWith(`${base}/`) ? path.slice(base.length + 1).split("/")[0] : "";
    return (tabs as readonly string[]).includes(seg) ? (seg as T) : first;
  };
  const [tab, setTab] = useState<T>(read);
  const shown = useContext(PageShown);
  const [seen, setSeen] = useState(shown);
  if (shown !== seen) {
    setSeen(shown);
    if (base && window.location.pathname.startsWith(base)) setTab(read());
  }
  const latest = useRef(read);
  useEffect(() => {
    latest.current = read;
  });
  useEffect(() => {
    if (!base) return;
    const back = () => window.location.pathname.startsWith(base) && setTab(latest.current());
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, [base]);
  const pick = (t: T) => {
    setTab(t);
    if (base && t !== tab) window.history.pushState(null, "", `${base}${t === first ? "" : `/${t}`}${window.location.search}`);
  };
  return [tab, pick];
}

/** True when a part sits on an opened page that isn't showing (kept loaded but inert), so window-wide keys skip it. */
export const offPage = (el: Element | null) => !el || Boolean(el.closest("[inert]"));

/** What the signed-in shell knows, for parts deep in a page that need it without passing props down. */
export type AppInfo = {
  workspace: { id: string; name: string } | null;
  user: { id: string; email: string | null } | null;
  role: "owner" | "admin" | "member" | null;
  navigate: (path: string) => void;
};
export const AppCtx = createContext<AppInfo | null>(null);
export const useApp = () => useContext(AppCtx);

/** Tell every loaded page that data changed, so lists and records reload. */
export const CHANGED = "pulsearr:changed";
export const announceChange = () => window.dispatchEvent(new Event(CHANGED));

/**
 * Load data once, and again when `reload` is called, `key` changes or its page is shown again.
 * With `cacheAs` (a key unique across the app, carrying the workspace and record ids), the screen shows its last copy
 * at once and swaps in the fresh one when it lands. A different `cacheAs` never shows another one's data: it shows its
 * own last copy, or nothing while loading.
 */
export function useLoad<T>(fn: () => Promise<T>, key: string, cacheAs?: string) {
  const shown = useContext(PageShown);
  const [state, setState] = useState<{ key: string | undefined; data: T | null }>(() => ({ key: cacheAs, data: cacheAs ? (seenData<T>(cacheAs) ?? null) : null }));
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  // A screen left before its answer came still keeps the answer for next time.
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
    };
  }, []);
  useEffect(() => {
    let live = true;
    const from = screenGen();
    // A prefetch already on its way is used instead of asking twice.
    const pending = cacheAs && tick === 0 ? asked(cacheAs) : undefined;
    const load = pending ? pending.then(() => seenData<T>(cacheAs!) ?? latest.current()) : latest.current();
    load
      .then((d) => {
        if (cacheAs && (live || gone.current)) remember(cacheAs, d, from);
        if (!live) return;
        setState({ key: cacheAs, data: d });
        setError("");
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [key, cacheAs, tick, shown]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    window.addEventListener(CHANGED, reload);
    return () => window.removeEventListener(CHANGED, reload);
  }, [reload]);
  const data = state.key === cacheAs ? state.data : cacheAs ? (seenData<T>(cacheAs) ?? null) : state.data;
  const set = useCallback(
    (v: SetStateAction<T | null>) =>
      setState((s) => {
        const cur = s.key === cacheAs ? s.data : cacheAs ? (seenData<T>(cacheAs) ?? null) : s.data;
        const d = typeof v === "function" ? (v as (p: T | null) => T | null)(cur) : v;
        if (cacheAs && d != null) remember(cacheAs, d);
        return { key: cacheAs, data: d };
      }),
    [cacheAs],
  );
  return { data, error: !cacheAs || state.key === cacheAs || !data ? error : "", reload, set };
}

/** useLoad that always keeps the last copy; `key` must be unique across the app. */
export function useCached<T>(fn: () => Promise<T>, key: string) {
  return useLoad(fn, key, key);
}

// The signed-in person's access token, from whatever owns the session (the sign-in code calls setTokenSource once).
let tokenSource: () => Promise<string | null> = async () => null;

/** Where postJson and postStream get the bearer token. */
export function setTokenSource(fn: () => Promise<string | null>) {
  tokenSource = fn;
}

/** The current access token, or null when signed out. */
export const getToken = () => tokenSource();

async function headers(): Promise<Record<string, string>> {
  const token = await tokenSource().catch(() => null);
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/** POST to one of our API routes as the signed-in person. Errors carry the response body. */
export async function postJson<T = Record<string, unknown>>(path: string, body: object, o: { timeoutMs?: number } = {}): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: await headers(), body: JSON.stringify(body), signal: o.timeoutMs ? AbortSignal.timeout(o.timeoutMs) : undefined }).catch((e: unknown) => {
    throw e instanceof Error && e.name === "TimeoutError" ? new Error("That took too long. Try again.") : e;
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? "Something went wrong."), { data, status: res.status });
  return data as T;
}

/** POST to a streamed action: `onProgress` gets each step, and the result comes back when it's done. */
export async function postStream<T = Record<string, unknown>>(path: string, body: object, onProgress?: (e: Record<string, unknown>) => void): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: await headers(), body: JSON.stringify(body) });
  return readStream<T>(res, onProgress);
}

/** Throw a Supabase-style `{ data, error }` error so useLoad shows it. */
export function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

/** "4 min ago", "yesterday". */
export function timeAgo(iso: string | null) {
  return fmtAgo(iso);
}

/** "Tue, Mar 4, 3:05 PM". */
export function when(iso: string) {
  return fmtDateTime(iso);
}

/** A page in the app: the header with crumbs, a serif title and the one primary action, an optional toolbar, then the
 *  content. */
export function Page({
  icon,
  title,
  count,
  actions,
  toolbar,
  tabs,
  flush = false,
  back,
  crumbs,
  onRename,
  badge,
  children,
}: {
  /** Beside the title: a record's status tag. */
  badge?: React.ReactNode;
  /** Makes the title editable in place: one click to edit, Enter or leaving the box saves, Escape cancels. */
  onRename?: (name: string) => void;
  tabs?: React.ReactNode;
  back?: { label: string; onClick: () => void };
  /** Where this page sits, left to right, above its own title: "Settings / Team". */
  crumbs?: { label: string; onClick: () => void }[];
  icon?: React.ReactNode;
  title: string;
  count?: number | string;
  actions?: React.ReactNode;
  toolbar?: React.ReactNode;
  flush?: boolean;
  children: React.ReactNode;
}) {
  const trail = [...(back ? [back] : []), ...(crumbs ?? [])];
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-panel px-6 py-4">
        <div className="min-w-0 flex-1">
          {trail.length ? (
            <nav aria-label="Breadcrumb" className="mb-1 flex min-w-0 flex-wrap items-center gap-1">
              {trail.map((c, i) => (
                <span key={`${i}:${c.label}`} className="contents">
                  <button type="button" onClick={c.onClick} className="min-w-0 rounded-xs text-left text-[13px] wrap-anywhere text-muted transition-colors duration-[var(--dur-hover)] hover:text-ink">
                    {c.label}
                  </button>
                  <span className="text-[13px] text-muted">/</span>
                </span>
              ))}
            </nav>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            {icon ? <span className="flex shrink-0 items-center text-muted [&_svg]:size-5">{icon}</span> : null}
            {onRename ? (
              <EditableTitle title={title} onRename={onRename} />
            ) : (
              <h1 aria-current="page" className="min-w-0 font-serif text-[24px] leading-[30px] font-medium wrap-anywhere">
                {title}
              </h1>
            )}
            {count != null ? <span className="text-[14px] text-muted tabular-nums">{count}</span> : null}
            {badge ? <span className="flex flex-wrap items-center gap-1.5">{badge}</span> : null}
          </div>
        </div>
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {tabs ? <div className="shrink-0 border-b border-line bg-panel px-6">{tabs}</div> : null}
      {toolbar ? <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-6 py-2">{toolbar}</div> : null}
      <div className={`min-h-0 flex-1 overflow-auto bg-panel ${flush ? "" : "p-4 md:p-6"}`}>{children}</div>
    </div>
  );
}

function EditableTitle({ title, onRename }: { title: string; onRename: (name: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const done = () => {
    const v = (draft ?? "").trim();
    setDraft(null);
    if (v && v !== title) onRename(v);
  };
  if (draft != null)
    return (
      <input
        autoFocus
        aria-label="Name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => (e.key === "Enter" ? done() : e.key === "Escape" ? setDraft(null) : null)}
        className="h-9 w-[min(480px,60vw)] rounded-md border border-brand bg-panel px-2 font-serif text-[24px] font-medium outline-none focus:shadow-focus"
      />
    );
  return (
    <h1 aria-current="page" className="min-w-0">
      <button type="button" title="Rename" onClick={() => setDraft(title)} className="max-w-full rounded-md px-1 -mx-1 text-left font-serif text-[24px] leading-[30px] font-medium wrap-anywhere transition-colors duration-[var(--dur-hover)] hover:bg-hover">
        {title}
      </button>
    </h1>
  );
}

/** A card: square, white with a 1px line (or `paper`: the paper fill and no line). No shadow. */
export function Panel({ children, className = "", paper = false }: { children: React.ReactNode; className?: string; paper?: boolean }) {
  return <div className={`${paper ? "bg-paper" : "border border-line bg-panel"} ${className}`}>{children}</div>;
}

/** A card's header row: its title, a count, and room for actions on the right. */
export function CardHead({ label, count, children }: { label: string; count?: number | string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-line px-6 py-3">
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="min-w-0 text-[16px] leading-[22px] font-semibold wrap-anywhere">{label}</span>
        {count != null ? <span className="text-[13px] text-muted tabular-nums">{count}</span> : null}
      </span>
      {children ? <div className="ml-auto flex flex-wrap items-center gap-1.5">{children}</div> : null}
    </div>
  );
}

/** A small caption. */
export function Fig({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`fig ${className}`}>{children}</p>;
}

/** Nothing to show yet: one drawing in the middle, a short serif title, one line and the button that makes the first
 *  one. `compact` is for a section inside a page instead of the whole page. */
export function Empty({ title, children, drawing = "pulse", icon, action, compact = false }: { title: string; children?: React.ReactNode; drawing?: DrawingKind; icon?: string | null; action?: React.ReactNode; compact?: boolean }) {
  return (
    <section className={`rise flex flex-col items-center justify-center px-6 text-center ${compact ? "py-12" : "min-h-[calc(100dvh-180px)] py-12"}`}>
      <Drawing kind={drawing} icon={icon} size={compact ? 160 : 220} />
      <h2 className={`mt-6 max-w-full font-serif font-medium wrap-break-word ${compact ? "text-[20px] leading-[26px]" : "text-[24px] leading-[30px]"}`}>{title}</h2>
      {children ? <div className="mt-2 max-w-sm text-[14px] wrap-break-word text-muted">{children}</div> : null}
      {action ? <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </section>
  );
}

/** A small "i" with a tooltip that wraps, for a short recommendation next to a setting. */
export function Hint({ text, align = "center" }: { text: string; align?: "center" | "end" }) {
  const ref = useRef<HTMLSpanElement>(null);
  const tip = useTip(0);
  return (
    <span ref={ref} {...tip.handlers} tabIndex={0} aria-label={text} className="relative inline-flex size-4 shrink-0 cursor-help items-center justify-center text-muted hover:text-ink focus-visible:text-ink">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </svg>
      {tip.on ? <Tip anchor={ref} text={text} placement={align === "end" ? "top-end" : "top"} wrap /> : null}
    </span>
  );
}

/** One short error line. A technical message (a database error, a code, a missing setup step) never shows as it is. */
export function ErrorNote({ message }: { message: string }) {
  return message ? (
    <p role="alert" className="border-l-2 border-danger bg-danger-soft px-3 py-2 text-[14px] wrap-break-word text-ink">
      {plainError(message)}
    </p>
  ) : null;
}

/** One short line that something worked. */
export function Notice({ message }: { message: string }) {
  return message ? (
    <p role="status" className="border-l-2 border-success bg-success-soft px-3 py-2 text-[14px] wrap-break-word text-ink">
      {message}
    </p>
  ) : null;
}

/**
 * The skeleton while a screen loads, in the shape of what's coming, so nothing jumps when the data lands: `rows` for
 * a short list, `table` for a list screen (a header row, then rows of cells), `record` for a record page (a header,
 * then fields beside the activity). Square hover-gray blocks, no motion.
 */
export function Loading({ shape = "rows" }: { shape?: "rows" | "table" | "record" } = {}) {
  if (shape === "table")
    return (
      <div className="px-6 py-4" role="status" aria-label="Loading">
        <div className="mb-3 flex items-center gap-2">
          <span className="bone h-9 w-56" />
          <span className="bone ml-auto h-9 w-24" />
        </div>
        <div className="flex h-10 items-center gap-6 border-b border-line">
          {[28, 16, 14, 12, 10].map((w, i) => (
            <span key={i} className="bone h-2.5" style={{ width: `${w}%` }} />
          ))}
        </div>
        {Array.from({ length: 12 }, (_, r) => (
          <div key={r} className="flex h-11 items-center gap-6 border-b border-line" style={{ opacity: 1 - r * 0.06 }}>
            <span className="flex items-center gap-2" style={{ width: "28%" }}>
              <span className="bone size-5 shrink-0" />
              <span className="bone h-2.5" style={{ width: `${55 + ((r * 13) % 35)}%` }} />
            </span>
            {[16, 14, 12, 10].map((w, i) => (
              <span key={i} className="bone h-2.5" style={{ width: `${w - ((r + i) % 3) * 2}%` }} />
            ))}
          </div>
        ))}
      </div>
    );
  if (shape === "record")
    return (
      <div className="p-6" role="status" aria-label="Loading">
        <div className="mb-6 flex items-center gap-3">
          <span className="bone size-10 shrink-0" />
          <span className="space-y-2">
            <span className="bone block h-4 w-48" />
            <span className="bone block h-2.5 w-28" />
          </span>
        </div>
        <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="space-y-4">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="flex items-center gap-4">
                <span className="bone h-2.5 w-24" />
                <span className="bone h-2.5" style={{ width: `${30 + ((i * 11) % 30)}%` }} />
              </div>
            ))}
          </div>
          <div className="space-y-5">
            <div className="flex gap-4 border-b border-line pb-3">
              {[14, 12, 16, 10, 10].map((w, i) => (
                <span key={i} className="bone h-2.5" style={{ width: `${w}%` }} />
              ))}
            </div>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="space-y-2">
                <span className="bone block h-2.5 w-1/3" />
                <span className="bone block h-2.5 w-4/5" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );

  return (
    <div className="space-y-4 p-6" role="status" aria-label="Loading">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-3" style={{ opacity: 1 - i * 0.14 }}>
          <span className="bone size-7 shrink-0" />
          <span className="bone h-2.5" style={{ width: `${24 + ((i * 7) % 18)}%` }} />
          <span className="bone ml-[6%] h-2.5 w-[14%]" />
          <span className="bone ml-[4%] h-2.5 w-[10%]" />
        </div>
      ))}
    </div>
  );
}

export type ButtonVariant = "primary" | "secondary" | "soft" | "plain" | "danger";

const BUTTON_LOOK: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-brand text-white hover:bg-brand-hover",
  secondary: "border-line bg-panel text-ink hover:bg-hover",
  soft: "border-transparent bg-brand-soft text-brand hover:bg-sky",
  plain: "border-transparent bg-transparent text-ink hover:bg-hover",
  danger: "border-danger bg-panel text-danger hover:bg-danger-soft",
};

/**
 * A button (docs/brand.md section 12): 36px tall (32px `small`), 8px corners, Inter 14px at 500. Primary is pulse
 * blue, the one main action on a screen; secondary is white with a line; soft is ice for picked or in-place actions;
 * danger is for delete and disconnect, always with askConfirm. A Modal's Enter finds its primary by `data-variant`.
 */
export function Button({ variant = "primary", small = false, className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; small?: boolean }) {
  return (
    <button
      {...props}
      data-variant={variant}
      className={`inline-flex items-center justify-center gap-2 rounded-md border px-4 py-1 text-center text-[14px] leading-5 font-medium transition-colors duration-[var(--dur-hover)] ease-[var(--ease)] disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0 ${small ? "min-h-8" : "min-h-9"} ${BUTTON_LOOK[variant]} ${className}`}
    />
  );
}

/** Tag tones: soft fill and deep text. Brand is the neutral tag (ice and pulse blue); the rest mean status only. */
export type Tone = "gray" | "brand" | "green" | "amber" | "red";
const TONES: Record<Tone, { bg: string; dot: string }> = {
  gray: { bg: "bg-hover text-ink", dot: "bg-muted" },
  brand: { bg: "bg-brand-soft text-brand", dot: "bg-brand" },
  green: { bg: "bg-success-soft text-success", dot: "bg-success" },
  amber: { bg: "bg-warning-soft text-warning", dot: "bg-warning" },
  red: { bg: "bg-danger-soft text-danger", dot: "bg-danger" },
};

/** A state: a 2px-corner tag, 20px tall, 12px text at 500, soft fill and deep text. */
export function Badge({ children, tone = "gray" }: { children: React.ReactNode; tone?: Tone }) {
  return <span className={`inline-flex min-h-5 max-w-full items-center gap-1 rounded-xs px-2 py-0.5 text-[12px] leading-4 font-medium wrap-anywhere ${TONES[tone].bg}`}>{children}</span>;
}

/** The 8px status dot, the one round thing in the app. */
export function Dot({ tone }: { tone: Tone }) {
  return <span className={`inline-block size-2 shrink-0 rounded-full ${TONES[tone].dot}`} />;
}

const initialsOf = (label: string) =>
  label
    .replace(/@.*/, "")
    .split(/[\s._\-–—]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/** A square avatar with initials, in ice and pulse blue. */
export function Avatar({ label, size = 24 }: { label: string; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center bg-brand-soft font-medium text-brand" style={{ width: size, height: size, fontSize: Math.max(9, size * 0.4) }} aria-hidden="true">
      {initialsOf(label)}
    </span>
  );
}

export function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="flex h-9 w-64 max-w-full items-center gap-2 rounded-md border border-line bg-panel px-3 text-muted transition-[border-color,box-shadow] duration-[var(--dur-hover)] focus-within:border-brand focus-within:shadow-focus">
      <SearchIcon size={16} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-muted" />
    </label>
  );
}

/** A page's tabs: words in muted, the picked one in ink with a 2px pulse-blue underline. Each tab is its own address
 *  (useAddressTab). */
export function TabNav<T extends string>({ value, tabs, onChange, label }: { value: T; tabs: { value: T; label: string; icon?: React.ReactNode; count?: number }[]; onChange: (v: T) => void; label: string }) {
  return (
    <nav className="flex flex-wrap items-end gap-x-4" aria-label={label}>
      {tabs.map((t) => {
        const on = value === t.value;
        return (
          <button
            key={t.value}
            type="button"
            aria-current={on ? "page" : undefined}
            onClick={() => onChange(t.value)}
            className={`relative inline-flex min-h-11 items-center gap-1.5 text-left text-[14px] font-medium transition-colors duration-[var(--dur-hover)] ease-[var(--ease)] after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:transition-colors after:duration-[var(--dur-hover)] [&_svg]:size-4 ${on ? "text-ink after:bg-brand" : "text-muted after:bg-transparent hover:text-ink"}`}
          >
            {t.icon}
            {t.label}
            {t.count != null ? <span className="text-[12px] font-normal text-muted tabular-nums">{t.count}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}

/** A row of choices where one is picked (chart views, never page tabs): 8px corners, the picked one on ice. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; icon?: React.ReactNode; count?: number }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex min-h-9 max-w-full flex-wrap items-stretch gap-0.5 rounded-md border border-line bg-panel p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`inline-flex min-h-[30px] items-center gap-1.5 rounded-[6px] px-3 py-0.5 text-left text-[13px] font-medium transition-colors duration-[var(--dur-hover)] ease-[var(--ease)] [&_svg]:size-4 ${value === o.value ? "bg-brand-soft text-brand" : "text-muted hover:text-ink"}`}
        >
          {o.icon}
          {o.label}
          {o.count != null ? <span className="tabular-nums opacity-70">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** A table header cell: 12px eyebrow-style label in muted, no fill, a line below. */
export function Th({ icon, children, className = "", style }: { icon?: React.ReactNode; children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <th style={style} className={`sticky top-0 z-10 h-10 border-b border-line bg-panel px-3 text-left align-middle text-[12px] leading-4 font-medium tracking-[0.06em] wrap-break-word text-muted uppercase [&.text-right>span]:justify-end ${className}`}>
      {/* A flex row, so every header's words sit on the same line whether or not it has an icon. */}
      <span className="flex min-h-4 items-center gap-1.5">
        {icon ? <span className="[&_svg]:size-4">{icon}</span> : null}
        {children}
      </span>
    </th>
  );
}

/** A table cell: rows at least 44px, a line between rows, 13px text. Numbers go right-aligned (`text-right num`). */
export function Td({ children, className = "", ...rest }: React.TdHTMLAttributes<HTMLTableCellElement> & { children: React.ReactNode; className?: string }) {
  return (
    <td {...rest} className={`h-11 border-b border-line px-3 py-2 text-[13px] leading-[18px] wrap-break-word ${className}`}>
      {children}
    </td>
  );
}

/** One number card: an eyebrow, the serif number, and a change line under it in its status color. With `picked`, the
 *  number that filters the list now. */
export function Stat({ label, value, sub, tone, onClick, picked }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "red" | "green" | "amber"; onClick?: () => void; picked?: boolean }) {
  const color = tone === "red" ? "text-danger" : tone === "green" ? "text-success" : tone === "amber" ? "text-warning" : "text-muted";
  const body = (
    <>
      <p className="eyebrow wrap-break-word">{label}</p>
      <div className="mt-2 font-serif text-[28px] leading-8 font-medium wrap-break-word text-ink tabular-nums">{value}</div>
      {sub ? <p className={`mt-1 text-[12px] leading-4 wrap-break-word tabular-nums ${color}`}>{sub}</p> : null}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} aria-pressed={picked} className={`min-w-0 px-6 py-5 text-left transition-colors duration-[var(--dur-hover)] ${picked ? "bg-brand-soft" : "bg-panel hover:bg-paper"}`}>
      {body}
    </button>
  ) : (
    <div className="min-w-0 bg-panel px-6 py-5">{body}</div>
  );
}

/** A row of Stats with 1px lines between them, square. */
export function StatStrip({ children, cols, className = "" }: { children: React.ReactNode; cols: 2 | 3 | 4 | 5 | 6; className?: string }) {
  const grid = { 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-4", 5: "md:grid-cols-5", 6: "md:grid-cols-6" }[cols];
  return <div className={`grid grid-cols-1 gap-px border border-line bg-line sm:grid-cols-2 ${grid} ${className}`}>{children}</div>;
}

/** The key numbers on a screen, all one size. */
export const StatCards = StatStrip;

/** A day as a small calendar page: the month on an ice band over the day. Past days take gray. */
export function DateTile({ at, past = false, size = "md" }: { at: string | number | Date; past?: boolean; size?: "sm" | "md" }) {
  const d = new Date(at);
  const month = fmtParts(d, { month: "short" }).toUpperCase();
  const sm = size === "sm";
  return (
    <span className={`flex shrink-0 flex-col border border-line bg-panel text-center ${sm ? "w-7" : "w-10"}`} aria-hidden="true">
      <span className={`font-medium tracking-[0.08em] ${sm ? "pt-px text-[8px] leading-[11px]" : "py-px text-[10px] leading-[14px]"} ${past ? "bg-hover text-muted" : "bg-brand-soft text-brand"}`}>{month}</span>
      <span className={`font-serif font-medium text-ink tabular-nums ${sm ? "text-[13px] leading-[17px]" : "pt-0.5 pb-1 text-[18px] leading-[20px]"}`}>{fmtParts(d, { day: "numeric" })}</span>
    </span>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-line bg-paper px-1 font-sans text-[11px] leading-none text-muted">{children}</kbd>;
}

/** Page content stays centered and no wider than this, so wide screens don't stretch one side. Body grids add their padding. */
export const WIDE = "mx-auto w-full max-w-[1280px]";
export const WIDE_BODY = "mx-auto w-full max-w-[1328px]";
/** Two columns for record pages: the story on one side, facts on the other. */
export const SPLIT = "grid gap-6 p-4 md:p-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]";

export type IconButtonVariant = "primary" | "secondary" | "plain";

/** A button that is only an icon: a 32px square with 8px corners. The label shows as a tooltip on hover and keyboard
 *  focus, and is read by screen readers. */
export function IconButton({
  label,
  variant = "plain",
  tip = "bottom",
  align = "center",
  className = "",
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; variant?: IconButtonVariant; tip?: "top" | "bottom"; align?: "center" | "start" | "end" }) {
  const look =
    variant === "primary"
      ? "border-transparent bg-brand text-white hover:bg-brand-hover"
      : variant === "secondary"
        ? "border-line bg-panel text-ink hover:bg-hover"
        : "border-transparent text-muted hover:bg-hover hover:text-ink";
  const ref = useRef<HTMLButtonElement>(null);
  const hover = useTip();
  const at = `${tip}${align === "center" ? "" : `-${align}`}` as "top" | "bottom" | "top-start" | "top-end" | "bottom-start" | "bottom-end";
  // Our tooltip handlers run first, then the caller's own.
  const on = (k: keyof typeof hover.handlers) => (e: never) => {
    (hover.handlers[k] as (e: unknown) => void)(e);
    (props[k] as ((e: unknown) => void) | undefined)?.(e);
  };
  return (
    <button
      type="button"
      {...props}
      ref={ref}
      onPointerEnter={on("onPointerEnter")}
      onPointerLeave={on("onPointerLeave")}
      onPointerDown={on("onPointerDown")}
      onFocus={on("onFocus")}
      onBlur={on("onBlur")}
      aria-label={label}
      className={`relative inline-flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors duration-[var(--dur-hover)] ease-[var(--ease)] disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4 ${look} ${className}`}
    >
      {children}
      {hover.on && !props.disabled ? <Tip anchor={ref} text={label} placement={at} /> : null}
    </button>
  );
}

/** The one look for a text box: 36px, white, a 1px line, 8px corners, the pulse-blue ring on focus. Set
 *  `aria-invalid` for the error border. */
export const inputClass =
  "h-9 w-full rounded-md border border-line bg-panel px-3 text-[14px] text-ink outline-none transition-[border-color,box-shadow] duration-[var(--dur-hover)] placeholder:text-muted focus:border-brand focus:shadow-focus aria-[invalid=true]:border-danger disabled:bg-paper disabled:text-muted";
export const areaClass =
  "w-full rounded-md border border-line bg-panel px-3 py-2 text-[14px] text-ink outline-none transition-[border-color,box-shadow] duration-[var(--dur-hover)] placeholder:text-muted focus:border-brand focus:shadow-focus aria-[invalid=true]:border-danger disabled:bg-paper disabled:text-muted";

export function Input({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${className}`} />;
}

export function TextArea({ className = "", ...props }: React.ComponentProps<"textarea">) {
  return <textarea {...props} className={`${areaClass} ${className}`} />;
}

/** A 13px ink label over its control, and the error under it in red. `aside` sits on the right of the label; `row`
 *  puts label and control side by side. */
export function Field({ label, aside, row = false, error, children }: { label: string; aside?: React.ReactNode; row?: boolean; error?: string; children: React.ReactNode }) {
  const err = error ? <p className="mt-1.5 text-[13px] wrap-break-word text-danger">{plainError(error)}</p> : null;
  if (row)
    return (
      <div className="grid grid-cols-1 items-center gap-1.5 sm:grid-cols-[160px_1fr] sm:gap-4">
        <span className="text-[13px] leading-[18px] wrap-break-word text-ink">{label}</span>
        <div className="min-w-0">
          {children}
          {err}
        </div>
      </div>
    );
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2">
        <span className="min-w-0 flex-1 text-[13px] leading-[18px] wrap-break-word text-ink">{label}</span>
        {aside}
      </div>
      {children}
      {err}
    </div>
  );
}

/** An on/off switch: a square-cornered track, pulse blue when on. */
export function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className={`relative h-5 w-9 shrink-0 rounded-xs transition-colors duration-[var(--dur-hover)] ease-[var(--ease)] disabled:cursor-not-allowed disabled:opacity-40 ${on ? "bg-brand" : "bg-line-strong"}`}>
      <span className={`absolute top-0.5 left-0.5 size-4 rounded-xs bg-white transition-transform duration-[var(--dur-hover)] ease-[var(--ease)] ${on ? "translate-x-4" : ""}`} />
    </button>
  );
}

/** A checkbox, one size and pulse blue. It can show "some picked" with `indeterminate`. */
export function Checkbox({ checked, indeterminate = false, onChange, label, disabled, className = "" }: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} onClick={(e) => e.stopPropagation()} className={`size-4 shrink-0 cursor-pointer accent-[var(--pulse-blue)] disabled:cursor-not-allowed disabled:opacity-40 ${className}`} />;
}

/** Copies text, then shows a check for a moment. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <IconButton label={done ? "Copied" : label} onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true))}>
      {done ? <Check size={16} /> : <Copy size={16} />}
    </IconButton>
  );
}
