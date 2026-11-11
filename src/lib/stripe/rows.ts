// Stripe objects to rows of the clean tables (008_stripe.sql): the typed columns for lookups and `raw`, the object
// as Stripe returned it (what the engine reads). Tolerant of API versions up to 2024 and from 2025, like the engine.
//
//   TABLES[name]               the table's columns and their Postgres types
//   toRow(table, object, ctx)  one row
//   upsertSql(table)           insert ... select from jsonb_to_recordset($3) ... on conflict do update, with
//                              $1 source_id, $2 workspace_id, $3 the rows as JSON, $4 when they were fetched. A row
//                              only replaces one fetched at the same time or earlier, so a slow backfill page can
//                              never undo a newer copy written by the sync.
//   dedupe(rows, key)          one row per key (the last), since one insert can't touch a row twice

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const idOf = (v: unknown): string | null => str(v) ?? (isObj(v) ? str(v.id) : null);
const get = (v: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), v);
const ts = (v: unknown): string | null => (num(v) != null ? new Date(num(v)! * 1000).toISOString() : null);
const lower = (v: unknown): string | null => str(v)?.toLowerCase() ?? null;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null);
const int = (v: unknown): number | null => (num(v) != null ? Math.trunc(num(v)!) : null);
const decimalText = (v: unknown): string | null => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? v : num(v) != null ? String(num(v)) : null);

type ColType = "text" | "timestamptz" | "boolean" | "bigint" | "numeric" | "int" | "jsonb";
export type TableSpec = { table: string; key: string[]; cols: [string, ColType][] };

export const TABLES = {
  customers: {
    table: "stripe_customers",
    key: ["id"],
    cols: [["id", "text"], ["email", "text"], ["name", "text"], ["currency", "text"], ["created", "timestamptz"], ["deleted", "boolean"], ["raw", "jsonb"]],
  },
  products: { table: "stripe_products", key: ["id"], cols: [["id", "text"], ["name", "text"], ["active", "boolean"], ["created", "timestamptz"], ["raw", "jsonb"]] },
  prices: {
    table: "stripe_prices",
    key: ["id"],
    cols: [
      ["id", "text"], ["product_id", "text"], ["currency", "text"], ["type", "text"], ["billing_scheme", "text"], ["tiers_mode", "text"],
      ["unit_amount", "bigint"], ["unit_amount_decimal", "numeric"], ["interval", "text"], ["interval_count", "int"], ["usage_type", "text"],
      ["active", "boolean"], ["created", "timestamptz"], ["raw", "jsonb"],
    ],
  },
  coupons: {
    table: "stripe_coupons",
    key: ["id"],
    cols: [
      ["id", "text"], ["name", "text"], ["percent_off", "numeric"], ["amount_off", "bigint"], ["currency", "text"], ["duration", "text"],
      ["duration_in_months", "int"], ["valid", "boolean"], ["created", "timestamptz"], ["raw", "jsonb"],
    ],
  },
  subscriptions: {
    table: "stripe_subscriptions",
    key: ["id"],
    cols: [
      ["id", "text"], ["customer_id", "text"], ["status", "text"], ["currency", "text"], ["created", "timestamptz"], ["start_date", "timestamptz"],
      ["current_period_start", "timestamptz"], ["current_period_end", "timestamptz"], ["trial_start", "timestamptz"], ["trial_end", "timestamptz"],
      ["cancel_at", "timestamptz"], ["cancel_at_period_end", "boolean"], ["canceled_at", "timestamptz"], ["ended_at", "timestamptz"],
      ["pause_collection", "jsonb"], ["raw", "jsonb"],
    ],
  },
  subscription_items: {
    table: "stripe_subscription_items",
    key: ["id"],
    cols: [["id", "text"], ["subscription_id", "text"], ["price_id", "text"], ["quantity", "bigint"], ["created", "timestamptz"], ["raw", "jsonb"]],
  },
  invoices: {
    table: "stripe_invoices",
    key: ["id"],
    cols: [
      ["id", "text"], ["customer_id", "text"], ["subscription_id", "text"], ["status", "text"], ["billing_reason", "text"], ["collection_method", "text"],
      ["currency", "text"], ["created", "timestamptz"], ["due_date", "timestamptz"], ["finalized_at", "timestamptz"], ["paid_at", "timestamptz"],
      ["amount_due", "bigint"], ["amount_paid", "bigint"], ["amount_remaining", "bigint"], ["subtotal", "bigint"], ["total", "bigint"], ["raw", "jsonb"],
    ],
  },
  invoice_lines: {
    table: "stripe_invoice_lines",
    key: ["invoice_id", "id"],
    cols: [
      ["invoice_id", "text"], ["id", "text"], ["customer_id", "text"], ["subscription_id", "text"], ["subscription_item_id", "text"], ["price_id", "text"],
      ["type", "text"], ["proration", "boolean"], ["quantity", "bigint"], ["amount", "bigint"], ["discount_amount", "bigint"], ["currency", "text"],
      ["period_start", "timestamptz"], ["period_end", "timestamptz"], ["raw", "jsonb"],
    ],
  },
  charges: {
    table: "stripe_charges",
    key: ["id"],
    cols: [
      ["id", "text"], ["customer_id", "text"], ["invoice_id", "text"], ["payment_intent_id", "text"], ["status", "text"], ["amount", "bigint"],
      ["amount_refunded", "bigint"], ["currency", "text"], ["paid", "boolean"], ["refunded", "boolean"], ["failure_code", "text"],
      ["failure_message", "text"], ["created", "timestamptz"], ["raw", "jsonb"],
    ],
  },
  refunds: {
    table: "stripe_refunds",
    key: ["id"],
    cols: [["id", "text"], ["charge_id", "text"], ["customer_id", "text"], ["amount", "bigint"], ["currency", "text"], ["status", "text"], ["reason", "text"], ["created", "timestamptz"], ["raw", "jsonb"]],
  },
} satisfies Record<string, TableSpec>;

export type TableName = keyof typeof TABLES;
export type Row = Record<string, unknown>;

/** The upsert for one table (see the top of this file for its parameters). */
export function upsertSql(name: TableName): string {
  const spec: TableSpec = TABLES[name];
  const cols = spec.cols.map(([c]) => c);
  const rec = spec.cols.map(([c, t]) => `"${c}" ${t}`).join(", ");
  const keyCols = ["source_id", ...spec.key];
  const updates = cols.filter((c) => !spec.key.includes(c)).map((c) => `"${c}" = excluded."${c}"`);
  return (
    `insert into public.${spec.table} (source_id, workspace_id, ${cols.map((c) => `"${c}"`).join(", ")}, updated_at) ` +
    `select $1::uuid, $2::uuid, ${cols.map((c) => `r."${c}"`).join(", ")}, $4::timestamptz from jsonb_to_recordset($3::jsonb) as r(${rec}) ` +
    `on conflict (${keyCols.join(", ")}) do update set ${[...updates, "updated_at = excluded.updated_at"].join(", ")} ` +
    `where public.${spec.table}.updated_at <= excluded.updated_at`
  );
}

export function dedupe<T extends Row>(rows: T[], key: string[] = ["id"]): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key.map((k) => String(r[k])).join("\u0000"), r);
  return [...m.values()];
}

// ---------- mappers ----------

export function customerRow(c: Obj): Row {
  return { id: str(c.id), email: str(c.email), name: str(c.name), currency: lower(c.currency), created: ts(c.created), deleted: c.deleted === true, raw: c };
}

export function productRow(p: Obj): Row {
  return { id: str(p.id), name: str(p.name), active: bool(p.active), created: ts(p.created), raw: p };
}

/** A price, or an old plan (same id space). */
export function priceRow(p: Obj): Row {
  const isPlan = p.object === "plan";
  const rec = isPlan ? p : isObj(p.recurring) ? p.recurring : null;
  return {
    id: str(p.id),
    product_id: idOf(p.product),
    currency: lower(p.currency),
    type: isPlan ? "recurring" : oneOf(p.type, ["recurring", "one_time"] as const),
    billing_scheme: str(p.billing_scheme),
    tiers_mode: str(p.tiers_mode),
    unit_amount: int(isPlan ? p.amount : p.unit_amount),
    unit_amount_decimal: decimalText(isPlan ? p.amount_decimal : p.unit_amount_decimal),
    interval: oneOf(rec?.interval, ["day", "week", "month", "year"] as const),
    interval_count: int(rec?.interval_count),
    usage_type: oneOf(rec?.usage_type, ["licensed", "metered"] as const),
    active: bool(p.active),
    created: ts(p.created),
    raw: p,
  };
}

export function couponRow(c: Obj): Row {
  return {
    id: str(c.id),
    name: str(c.name),
    percent_off: decimalText(c.percent_off),
    amount_off: int(c.amount_off),
    currency: lower(c.currency),
    duration: oneOf(c.duration, ["once", "repeating", "forever"] as const),
    duration_in_months: int(c.duration_in_months),
    valid: bool(c.valid),
    created: ts(c.created),
    raw: c,
  };
}

/** The subscription's own row. Its period dates sit on the items from API 2025 on. */
export function subscriptionRow(s: Obj): Row {
  const firstItem = (get(s, "items", "data") as unknown[] | undefined)?.find(isObj) as Obj | undefined;
  return {
    id: str(s.id),
    customer_id: idOf(s.customer),
    status: str(s.status) ?? "active",
    currency: lower(s.currency),
    created: ts(s.created),
    start_date: ts(s.start_date),
    current_period_start: ts(s.current_period_start ?? firstItem?.current_period_start),
    current_period_end: ts(s.current_period_end ?? firstItem?.current_period_end),
    trial_start: ts(s.trial_start),
    trial_end: ts(s.trial_end),
    cancel_at: ts(s.cancel_at),
    cancel_at_period_end: s.cancel_at_period_end === true,
    canceled_at: ts(s.canceled_at),
    ended_at: ts(s.ended_at),
    pause_collection: isObj(s.pause_collection) ? s.pause_collection : null,
    raw: s,
  };
}

export function subscriptionItemRow(it: Obj, subscriptionId: string): Row {
  return {
    id: str(it.id),
    subscription_id: idOf(it.subscription) ?? subscriptionId,
    price_id: idOf(it.price ?? it.plan),
    quantity: int(it.quantity),
    created: ts(it.created),
    raw: it,
  };
}

export const invoiceSubscription = (inv: Obj): string | null => idOf(inv.subscription) ?? idOf(get(inv, "parent", "subscription_details", "subscription"));

export function invoiceRow(inv: Obj): Row {
  const st = get(inv, "status_transitions");
  return {
    id: str(inv.id),
    customer_id: idOf(inv.customer),
    subscription_id: invoiceSubscription(inv),
    status: oneOf(inv.status, ["draft", "open", "paid", "uncollectible", "void"] as const),
    billing_reason: str(inv.billing_reason),
    collection_method: str(inv.collection_method),
    currency: lower(inv.currency),
    created: ts(inv.created),
    due_date: ts(inv.due_date),
    finalized_at: ts(get(st, "finalized_at")),
    paid_at: ts(get(st, "paid_at")),
    amount_due: int(inv.amount_due),
    amount_paid: int(inv.amount_paid),
    amount_remaining: int(inv.amount_remaining),
    subtotal: int(inv.subtotal),
    total: int(inv.total),
    raw: inv,
  };
}

export function invoiceLineRow(l: Obj, inv: { id: string; customerId: string; subscriptionId: string | null }): Row {
  const parent = get(l, "parent");
  const si = get(parent, "subscription_item_details");
  const ii = get(parent, "invoice_item_details");
  const isSub = l.type === "subscription" || get(parent, "type") === "subscription_item_details";
  const discount = (Array.isArray(l.discount_amounts) ? l.discount_amounts : []).reduce<number>((acc, d) => acc + (num(get(d, "amount")) ?? 0), 0);
  return {
    invoice_id: inv.id,
    id: str(l.id),
    customer_id: inv.customerId,
    subscription_id: idOf(l.subscription) ?? idOf(get(si, "subscription")) ?? idOf(get(ii, "subscription")) ?? inv.subscriptionId,
    subscription_item_id: idOf(l.subscription_item) ?? idOf(get(si, "subscription_item")),
    price_id: idOf(l.price ?? l.plan) ?? idOf(get(l, "pricing", "price_details", "price")),
    type: isSub ? "subscription" : (str(l.type) ?? "invoiceitem"),
    proration: l.proration === true || get(si, "proration") === true || get(ii, "proration") === true,
    quantity: int(l.quantity),
    amount: int(l.amount),
    discount_amount: Math.trunc(discount),
    currency: lower(l.currency),
    period_start: ts(get(l, "period", "start")),
    period_end: ts(get(l, "period", "end")),
    raw: l,
  };
}

export function chargeRow(c: Obj): Row {
  return {
    id: str(c.id),
    customer_id: idOf(c.customer),
    invoice_id: idOf(c.invoice),
    payment_intent_id: idOf(c.payment_intent),
    status: oneOf(c.status, ["succeeded", "pending", "failed"] as const),
    amount: int(c.amount),
    amount_refunded: int(c.amount_refunded),
    currency: lower(c.currency),
    paid: bool(c.paid),
    refunded: bool(c.refunded),
    failure_code: str(c.failure_code),
    failure_message: str(c.failure_message)?.slice(0, 2000) ?? null,
    created: ts(c.created),
    raw: c,
  };
}

/**
 * A refund. Fetched with its charge expanded (to learn the customer); the stored copy names the charge by id, as an
 * unexpanded refund would.
 */
export function refundRow(r: Obj, customerId: string | null = null): Row {
  const charge = r.charge;
  const raw = isObj(charge) ? { ...r, charge: idOf(charge) } : r;
  return {
    id: str(r.id),
    charge_id: idOf(charge),
    customer_id: customerId ?? (isObj(charge) ? idOf(charge.customer) : null),
    amount: int(r.amount),
    currency: lower(r.currency),
    status: str(r.status),
    reason: str(r.reason),
    created: ts(r.created),
    raw,
  };
}

/** The charge expanded on a refund, if it was. */
export const expandedCharge = (r: Obj): Obj | null => (isObj(r.charge) ? r.charge : null);
