// Stripe webhooks and events (docs/m1-plan.md section 2).
//
//   verifySignature(body, header, secret, { now, toleranceS })  the Stripe-Signature check: HMAC-SHA256 of
//       `${t}.${body}` with the endpoint's secret, compared in constant time with every v1 value, and t within 5
//       minutes. Throws SignatureError; never trusts the body before this passes.
//   signatureHeader(body, secret, t)   the header Stripe would send (tests, local tools)
//   parseEvent(event)                  the row stripe_events keeps, and which object to fetch fresh for it

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_TOLERANCE_S = 300;

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureError";
  }
}

const hmac = (secret: string, t: string, body: string) => createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");

export function verifySignature(body: string, header: string | null, secret: string, o: { now?: number; toleranceS?: number } = {}): { t: number } {
  if (!secret) throw new SignatureError("No webhook secret");
  if (!header || header.length > 4000) throw new SignatureError("No signature");
  let t = "";
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1.push(v);
  }
  if (!/^\d{1,12}$/.test(t) || !v1.length) throw new SignatureError("Bad signature header");
  const at = Number(t);
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  if (Math.abs(now - at) > (o.toleranceS ?? SIGNATURE_TOLERANCE_S)) throw new SignatureError("The signature is too old");
  const want = Buffer.from(hmac(secret, t, body), "hex");
  const ok = v1.some((sig) => {
    if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
    const got = Buffer.from(sig, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  });
  if (!ok) throw new SignatureError("The signature doesn't match");
  return { t: at };
}

export function signatureHeader(body: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${hmac(secret, String(t), body)}`;
}

// ---------- events ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const idOf = (v: unknown): string | null => str(v) ?? (isObj(v) ? str(v.id) : null);

/** The objects the sync fetches and keeps. */
export const SYNC_TYPES = ["customer", "subscription", "invoice", "charge", "refund", "price", "product", "coupon"] as const;
export type SyncType = (typeof SYNC_TYPES)[number];
export const isSyncType = (v: unknown): v is SyncType => typeof v === "string" && (SYNC_TYPES as readonly string[]).includes(v);

/** What stripe_events keeps for one event, plus the object to fetch fresh for it (null: nothing we keep). */
export type EventRow = {
  id: string;
  type: string;
  /** ISO time. */
  created: string;
  object_id: string | null;
  customer_id: string | null;
  changed: string[] | null;
  sync_type: SyncType | null;
  sync_id: string | null;
};

export type ParsedEvent = EventRow & { account: string | null; livemode: boolean };

/** Read a Stripe event. Null when it isn't an event. */
export function parseEvent(e: unknown): ParsedEvent | null {
  if (!isObj(e) || e.object !== "event") return null;
  const id = str(e.id);
  const type = str(e.type);
  const created = typeof e.created === "number" && Number.isFinite(e.created) ? e.created : null;
  if (!id || !/^evt_[A-Za-z0-9_]+$/.test(id) || !type || created == null) return null;
  const data = isObj(e.data) ? e.data : {};
  const obj = isObj(data.object) ? data.object : {};
  const kind = str(obj.object);
  const objectId = str(obj.id);
  const prev = data.previous_attributes;
  const customer = kind === "customer" ? objectId : idOf(obj.customer);

  // Which object to fetch: the object itself when we keep it; a discount or invoice item through its parent.
  let syncType: SyncType | null = null;
  let syncId: string | null = null;
  if (kind === "plan" && objectId) [syncType, syncId] = ["price", objectId];
  else if (isSyncType(kind) && objectId) [syncType, syncId] = [kind, objectId];
  else if (kind === "discount") {
    const sub = idOf(obj.subscription);
    if (sub) [syncType, syncId] = ["subscription", sub];
    else if (customer) [syncType, syncId] = ["customer", customer];
  } else if (kind === "invoiceitem") {
    const inv = idOf(obj.invoice);
    if (inv) [syncType, syncId] = ["invoice", inv];
  }
  return {
    id,
    type,
    created: new Date(created * 1000).toISOString(),
    object_id: objectId,
    customer_id: customer && /^cus_/.test(customer) ? customer : null,
    changed: isObj(prev) ? Object.keys(prev).sort() : null,
    sync_type: syncType,
    sync_id: syncId,
    account: str(e.account),
    livemode: e.livemode === true,
  };
}

/** The stored row, without the routing fields. */
export const eventRow = (e: ParsedEvent): EventRow => ({
  id: e.id,
  type: e.type,
  created: e.created,
  object_id: e.object_id,
  customer_id: e.customer_id,
  changed: e.changed,
  sync_type: e.sync_type,
  sync_id: e.sync_id,
});
