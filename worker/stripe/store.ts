// Writing Stripe objects with their children: a subscription and its items, an invoice and its lines (the invoice
// row first, since lines point at it), a charge and its refunds. A list Stripe cut short (has_more) is fetched in
// full; with the full list in hand, children Stripe no longer has are removed (when they weren't written later).

import {
  chargeRow,
  couponRow,
  customerRow,
  expandedCharge,
  invoiceLineRow,
  invoiceRow,
  invoiceSubscription,
  priceRow,
  productRow,
  refundRow,
  subscriptionItemRow,
  subscriptionRow,
  type StripeClient,
  type StripeObject,
} from "../../src/lib/stripe/index.ts";
import type { Db } from "../pg.ts";
import { upsertRows, type Source } from "./source.ts";

type Obj = Record<string, unknown>;
export type Ctx = { db: Db; source: Pick<Source, "id" | "workspace_id">; stripe: StripeClient };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const idOf = (v: unknown): string | null => str(v) ?? (isObj(v) ? str(v.id) : null);
const inline = (v: unknown): { data: Obj[]; hasMore: boolean } =>
  isObj(v) && Array.isArray(v.data) ? { data: v.data.filter(isObj), hasMore: v.has_more === true } : { data: [], hasMore: false };

/** The customers these objects belong to. */
export const customersOf = (objs: Obj[]): string[] => objs.map((o) => (o.object === "customer" ? str(o.id) : idOf(o.customer))).filter((c): c is string => !!c && c.startsWith("cus_"));

export const storeCustomers = (c: Ctx, objs: Obj[], at: string) => upsertRows(c.db, c.source, "customers", objs.map(customerRow), at);
export const storeProducts = (c: Ctx, objs: Obj[], at: string) => upsertRows(c.db, c.source, "products", objs.map(productRow), at);
export const storePrices = (c: Ctx, objs: Obj[], at: string) => upsertRows(c.db, c.source, "prices", objs.map(priceRow), at);
export const storeCoupons = (c: Ctx, objs: Obj[], at: string) => upsertRows(c.db, c.source, "coupons", objs.map(couponRow), at);

export async function storeSubscriptions(c: Ctx, subs: Obj[], at: string): Promise<number> {
  const n = await upsertRows(c.db, c.source, "subscriptions", subs.map(subscriptionRow), at);
  for (const s of subs) {
    const id = str(s.id);
    if (!id) continue;
    const list = inline(s.items);
    const items = list.hasMore ? await c.stripe.listAll("/v1/subscription_items", { subscription: id }) : list.data;
    await upsertRows(c.db, c.source, "subscription_items", items.map((it) => subscriptionItemRow(it, id)), at);
    await c.db.query(
      "delete from public.stripe_subscription_items where source_id = $1 and subscription_id = $2 and not (id = any($3::text[])) and updated_at <= $4::timestamptz",
      [c.source.id, id, items.map((it) => str(it.id)).filter(Boolean), at],
    );
  }
  return n;
}

export async function storeInvoices(c: Ctx, invoices: Obj[], at: string): Promise<number> {
  const ok = invoices.filter((inv) => str(inv.id) && idOf(inv.customer));
  const n = await upsertRows(c.db, c.source, "invoices", ok.map(invoiceRow), at);
  for (const inv of ok) {
    const id = str(inv.id)!;
    const list = inline(inv.lines);
    const lines: StripeObject[] = list.hasMore ? await c.stripe.listAll(`/v1/invoices/${encodeURIComponent(id)}/lines`) : list.data;
    const head = { id, customerId: idOf(inv.customer)!, subscriptionId: invoiceSubscription(inv) };
    await upsertRows(c.db, c.source, "invoice_lines", lines.map((l) => invoiceLineRow(l, head)), at);
    await c.db.query(
      "delete from public.stripe_invoice_lines where source_id = $1 and invoice_id = $2 and not (id = any($3::text[])) and updated_at <= $4::timestamptz",
      [c.source.id, id, lines.map((l) => str(l.id)).filter(Boolean), at],
    );
  }
  return n;
}

export const storeCharges = (c: Ctx, charges: Obj[], at: string) => upsertRows(c.db, c.source, "charges", charges.map(chargeRow), at);

/** Refunds fetched with `expand[]=charge` (or given their charge's customer): the charges are fresh too, so kept. */
export async function storeRefunds(c: Ctx, refunds: Obj[], at: string, customerId: string | null = null): Promise<number> {
  const charges = refunds.map(expandedCharge).filter((x): x is Obj => !!x);
  if (charges.length) await storeCharges(c, charges, at);
  return upsertRows(c.db, c.source, "refunds", refunds.map((r) => refundRow(r, customerId)), at);
}

/** Customers of refunds, through their expanded charges. */
export const refundCustomers = (refunds: Obj[]) => customersOf(refunds.map(expandedCharge).filter((x): x is Obj => !!x));
