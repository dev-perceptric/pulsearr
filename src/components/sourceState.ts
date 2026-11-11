// Connected Stripe accounts as the screens show them (Settings → Sources and the dashboard), and the live feed's rows.
// Pure, so it's tested in Node (tests/screens.test.ts).

import { fmtNum } from "../lib/format.ts";

export type SourceStatus = "connecting" | "importing" | "live" | "error" | "disconnected";
export type Backfill = Record<string, { cursor?: string | null; done?: boolean; count?: number }>;
export type Source = {
  id: string;
  kind: "stripe_app" | "stripe_key";
  account_id: string;
  account_name: string | null;
  livemode: boolean;
  status: SourceStatus;
  backfill: Backfill;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
};

/** The columns members may read (008_stripe.sql): never select *, the sealed token columns aren't granted. */
export const SOURCE_COLUMNS = "id, kind, account_id, account_name, livemode, status, backfill, last_synced_at, last_error, created_at";

const STATUSES = new Set<string>(["connecting", "importing", "live", "error", "disconnected"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Rows from the sources table, checked; anything malformed drops out. */
export function parseSources(rows: unknown): Source[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r): Source[] => {
    if (!isObj(r) || typeof r.id !== "string" || typeof r.account_id !== "string" || !STATUSES.has(String(r.status))) return [];
    const backfill: Backfill = {};
    if (isObj(r.backfill))
      for (const [k, v] of Object.entries(r.backfill))
        if (isObj(v)) backfill[k] = { cursor: typeof v.cursor === "string" ? v.cursor : null, done: v.done === true, count: Number.isFinite(Number(v.count)) ? Number(v.count) : 0 };
    return [
      {
        id: r.id,
        kind: r.kind === "stripe_key" ? "stripe_key" : "stripe_app",
        account_id: r.account_id,
        account_name: typeof r.account_name === "string" && r.account_name.trim() ? r.account_name : null,
        livemode: r.livemode !== false,
        status: r.status as SourceStatus,
        backfill,
        last_synced_at: typeof r.last_synced_at === "string" ? r.last_synced_at : null,
        last_error: typeof r.last_error === "string" && r.last_error ? r.last_error : null,
        created_at: typeof r.created_at === "string" ? r.created_at : "",
      },
    ];
  });
}

export const STATUS_LABEL: Record<SourceStatus, string> = { connecting: "Connecting", importing: "Importing", live: "Live", error: "Needs a look", disconnected: "Disconnected" };
export const statusTone = (s: SourceStatus): "green" | "brand" | "red" | "gray" => (s === "live" ? "green" : s === "error" ? "red" : s === "disconnected" ? "gray" : "brand");

// Stripe's object types in the order a backfill reads them, with the words for a count of each.
const OBJECTS: [string, string, string][] = [
  ["customers", "customer", "customers"],
  ["products", "product", "products"],
  ["prices", "price", "prices"],
  ["coupons", "coupon", "coupons"],
  ["subscriptions", "subscription", "subscriptions"],
  ["invoices", "invoice", "invoices"],
  ["charges", "charge", "charges"],
  ["refunds", "refund", "refunds"],
  ["events", "event", "events"],
];
const ORDER = new Map(OBJECTS.map(([k], i) => [k, i]));
const words = (k: string, n: number) => {
  const w = OBJECTS.find(([key]) => key === k);
  const one = w?.[1] ?? k.replace(/_/g, " ").replace(/s$/, "");
  const many = w?.[2] ?? k.replace(/_/g, " ");
  return `${fmtNum(n)} ${n === 1 ? one : many}`;
};

/** How far an import has come: the objects read so far ("1,240 customers, 3,100 invoices"), and whether all are done. */
export function importProgress(b: Backfill): { done: boolean; text: string; total: number } {
  const keys = Object.keys(b).sort((x, y) => (ORDER.get(x) ?? 99) - (ORDER.get(y) ?? 99) || (x < y ? -1 : 1));
  const counted = keys.filter((k) => (b[k]?.count ?? 0) > 0);
  const total = counted.reduce((s, k) => s + (b[k]?.count ?? 0), 0);
  return { done: keys.length > 0 && keys.every((k) => b[k]?.done), text: counted.map((k) => words(k, b[k]!.count!)).join(", "), total };
}

/** What the dashboard shows: nothing connected, the first import, or the numbers. */
export function dashboardState(sources: Source[]): "none" | "importing" | "live" | "error" {
  const on = sources.filter((s) => s.status !== "disconnected");
  if (!on.length) return "none";
  if (on.some((s) => s.status === "live")) return "live";
  if (on.some((s) => s.status === "importing" || s.status === "connecting")) return "importing";
  return "error";
}

/** The most recent sync of any connected account, for "From Stripe, updated 4 min ago". */
export function lastSynced(sources: Source[]): string | null {
  let best: string | null = null;
  for (const s of sources) if (s.last_synced_at && (!best || Date.parse(s.last_synced_at) > Date.parse(best))) best = s.last_synced_at;
  return best;
}

/** The line for a ?error= code the Stripe connect callback sends back. Unknown codes get the general line. */
export function connectError(code: string | null | undefined): string {
  switch ((code ?? "").trim()) {
    case "":
      return "";
    // The codes /api/stripe/callback sends: denied, state, code, setup, exchange, account, save.
    case "access_denied":
    case "denied":
      return "Stripe wasn't connected. Try again when you're ready.";
    case "state":
    case "invalid_state":
    case "expired":
      return "That link expired. Connect Stripe again.";
    case "setup":
      return "Connect Stripe isn't available right now. Use a restricted key.";
    case "account":
      return "Couldn't read that Stripe account. Try again.";
    case "already_connected":
    case "account_taken":
      return "That Stripe account is already connected to another workspace.";
    case "not_admin":
    case "forbidden":
      return "Only owners and admins can connect Stripe.";
    case "invalid_key":
      return "Stripe didn't accept that key.";
    case "permissions":
    case "missing_permissions":
      return "That key can't read billing data. Give it read access and try again.";
    default:
      return "Couldn't connect Stripe. Try again.";
  }
}

/** Whether a pasted key looks like a Stripe restricted or secret key, before it's sent. */
export const looksLikeKey = (v: string) => /^(rk|sk)_(live|test)_[A-Za-z0-9]{10,}$/.test(v.trim());

// ---------- The live feed ----------

export type FeedKind = "signup" | "upgrade" | "downgrade" | "cancel" | "reactivation" | "failed_payment" | "refund";
export type FeedItem = {
  id: string;
  at: string;
  kind: FeedKind;
  customer_id: string;
  customer_name: string | null;
  customer_email: string | null;
  amount: number;
  currency: string;
  original_amount: number;
  original_currency: string;
};

export const FEED_LABEL: Record<FeedKind, string> = {
  signup: "Signup",
  upgrade: "Upgrade",
  downgrade: "Downgrade",
  cancel: "Cancel",
  reactivation: "Reactivation",
  failed_payment: "Failed payment",
  refund: "Refund",
};
export const feedTone = (k: FeedKind): "green" | "red" | "amber" | "gray" =>
  k === "signup" || k === "upgrade" || k === "reactivation" ? "green" : k === "downgrade" || k === "cancel" ? "red" : k === "failed_payment" ? "amber" : "gray";

const FEED_KINDS = new Set<string>(Object.keys(FEED_LABEL));

/** feed()'s rows, checked. */
export function parseFeed(rows: unknown): FeedItem[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r): FeedItem[] => {
    if (!isObj(r) || typeof r.id !== "string" || typeof r.at !== "string" || !FEED_KINDS.has(String(r.kind)) || !Number.isFinite(Date.parse(r.at))) return [];
    const amount = Number(r.amount);
    const original = Number(r.original_amount);
    return [
      {
        id: r.id,
        at: r.at,
        kind: r.kind as FeedKind,
        customer_id: typeof r.customer_id === "string" ? r.customer_id : "",
        customer_name: typeof r.customer_name === "string" && r.customer_name ? r.customer_name : null,
        customer_email: typeof r.customer_email === "string" && r.customer_email ? r.customer_email : null,
        amount: Number.isFinite(amount) ? amount : 0,
        currency: typeof r.currency === "string" ? r.currency : "usd",
        original_amount: Number.isFinite(original) ? original : Number.isFinite(amount) ? amount : 0,
        original_currency: typeof r.original_currency === "string" ? r.original_currency : typeof r.currency === "string" ? r.currency : "usd",
      },
    ];
  });
}

const newestFirst = (a: FeedItem, b: FeedItem) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Two pages of the feed as one list: each item once (the later copy wins), newest first, as feed() orders them. */
export function mergeFeed(have: FeedItem[], incoming: FeedItem[]): FeedItem[] {
  const by = new Map<string, FeedItem>();
  for (const f of have) by.set(f.id, f);
  for (const f of incoming) by.set(f.id, f);
  return [...by.values()].sort(newestFirst);
}

/**
 * The p_before for the next older page. feed() takes items strictly before it, so a page that ends in the middle of
 * several items at the same moment would skip the rest: ask from just after the last one and let mergeFeed drop the
 * repeats. `stuck` (the last ask brought nothing new) asks strictly before it instead, so paging always moves on.
 */
export function olderCursor(items: FeedItem[], stuck = false): string | null {
  const last = items[items.length - 1];
  if (!last) return null;
  return stuck ? last.at : new Date(Date.parse(last.at) + 1).toISOString();
}
