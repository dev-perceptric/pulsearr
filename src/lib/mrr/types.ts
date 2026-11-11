// The MRR engine's input and output. The input is one Stripe customer's billing data, already mapped from Stripe's
// objects by fromStripe() in ./stripe.ts. Times are unix seconds, money is whole cents in the object's currency,
// and currencies are lowercase ISO codes ("usd").

export type Interval = "day" | "week" | "month" | "year";
export type Recurring = { interval: Interval; intervalCount: number; usageType: "licensed" | "metered" };
/** One price tier. upTo null is the last tier. Amounts are cents as decimal text ("400", "0.5"). */
export type Tier = { upTo: number | null; unitAmount: string | null; flatAmount: string | null };

export type Price = {
  id: string;
  currency: string;
  productId: string | null;
  /** Cents per unit as decimal text (Stripe's unit_amount_decimal); null for tiered prices. */
  unitAmount: string | null;
  billingScheme: "per_unit" | "tiered";
  tiersMode: "graduated" | "volume" | null;
  tiers: Tier[];
  /** null for one-time prices, which never count toward MRR. */
  recurring: Recurring | null;
  transformQuantity: { divideBy: number; round: "up" | "down" } | null;
};

export type Coupon = {
  id: string;
  /** "50" for 50% off. */
  percentOff: string | null;
  /** Cents off each invoice, in `currency`. */
  amountOff: number | null;
  currency: string | null;
  duration: "once" | "repeating" | "forever";
  /** Product ids the coupon is limited to; null for every product. */
  appliesTo: string[] | null;
};

/** A coupon applied to a subscription or customer, from `start` until `end` (null: no end). */
export type Discount = {
  id: string;
  couponId: string;
  scope: "subscription" | "customer" | "invoice";
  subscriptionId: string | null;
  start: number;
  end: number | null;
};

export type SubscriptionItem = { id: string; priceId: string; quantity: number };

/** A customer.subscription.updated (or paused, resumed) event: when, and which fields changed (null: unknown). */
export type SubscriptionUpdate = { at: number; fields: string[] | null; eventId: string };

export type Subscription = {
  id: string;
  currency: string;
  status: string;
  created: number;
  startDate: number | null;
  trialStart: number | null;
  trialEnd: number | null;
  endedAt: number | null;
  canceledAt: number | null;
  pauseCollection: { behavior: string; resumesAt: number | null } | null;
  /** The items as they are now. */
  items: SubscriptionItem[];
  updates: SubscriptionUpdate[];
};

export type InvoiceLine = {
  id: string;
  /** "subscription" for a subscription's own line, "invoiceitem" for one-off items and (in older API versions) prorations. */
  kind: "subscription" | "invoiceitem";
  subscriptionId: string | null;
  subscriptionItemId: string | null;
  priceId: string | null;
  quantity: number;
  /** Cents before discounts. */
  amount: number;
  /** Cents of discounts on this line. */
  discount: number;
  proration: boolean;
  periodStart: number;
  periodEnd: number;
};

export type Invoice = {
  id: string;
  subscriptionId: string | null;
  status: "draft" | "open" | "paid" | "uncollectible" | "void";
  currency: string;
  created: number;
  /** The due date; for invoices charged automatically, when they were finalized. */
  dueAt: number;
  paidAt: number | null;
  amountDue: number;
  lines: InvoiceLine[];
};

export type Charge = { id: string; created: number; amount: number; currency: string; status: "succeeded" | "pending" | "failed"; invoiceId: string | null };
export type Refund = { id: string; created: number; amount: number; currency: string; status: string; chargeId: string | null };

/** One day's rate: 1 `base` buys `rate` of `quote` (European Central Bank: base "eur"). */
export type FxRate = { day: string; base: string; quote: string; rate: string };

export type MrrInput = {
  customerId: string;
  /** The workspace currency every movement is counted in. */
  currency: string;
  /** The last day to build, YYYY-MM-DD (UTC). Nothing after it counts. */
  asOf: string;
  subscriptions: Subscription[];
  invoices: Invoice[];
  prices: Price[];
  coupons: Coupon[];
  discounts: Discount[];
  charges: Charge[];
  refunds: Refund[];
  fx: FxRate[];
};

export type MovementKind = "new" | "expansion" | "contraction" | "churn" | "reactivation";
/** The Stripe object behind a change: an invoice, the subscription as it is now, or a subscription event. */
export type Cause = { type: "invoice" | "subscription" | "event"; id: string };

export type Movement = {
  day: string;
  /** The moment of the change behind it (unix seconds). */
  at: number;
  kind: MovementKind;
  /** Cents in the workspace currency: positive for new, expansion and reactivation, negative for the rest. */
  amount: number;
  mrrBefore: number;
  mrrAfter: number;
  /** The workspace currency. */
  currency: string;
  /** The same change in the customer's own currency. */
  originalAmount: number;
  originalCurrency: string;
  /** That day's rate from originalCurrency to currency, as decimal text ("1" when they're the same). */
  rate: string;
  subscriptionId: string | null;
  cause: Cause;
};

/** One subscription's MRR, in its own currency, from `from` until the day before `to` (null: still). */
export type Segment = { subscriptionId: string; from: string; to: string | null; mrr: number; currency: string };

/** The customer's MRR from `from` until the day before `to` (null: still): workspace cents and own-currency cents. */
export type CustomerDay = { from: string; to: string | null; mrr: number; mrrNative: number; nativeCurrency: string; rate: string };

export type BuildResult = {
  customerId: string;
  currency: string;
  /** MRR on the asOf day, in workspace cents. Always the sum of the movements. */
  mrr: number;
  segments: Segment[];
  days: CustomerDay[];
  movements: Movement[];
};

export type FeedKind = "signup" | "upgrade" | "downgrade" | "cancel" | "reactivation" | "failed_payment" | "refund";

export type FeedItem = {
  /** Unique per source: the same input always gives the same keys. */
  key: string;
  kind: FeedKind;
  customerId: string;
  at: number;
  day: string;
  /** Workspace cents: the MRR change for MRR kinds (signed), the money for failed payments and refunds. */
  amount: number;
  currency: string;
  originalAmount: number;
  originalCurrency: string;
  objectType: "invoice" | "subscription" | "event" | "charge" | "refund";
  objectId: string;
};
