// The Stripe client and helpers (docs/m1-plan.md sections 1 and 2). Node runs these files directly, in the tests
// and the worker: relative imports with the .ts extension only.

export * from "./client.ts";
export * from "./oauth.ts";
export * from "./webhook.ts";
export * from "./keys.ts";
export * from "./rows.ts";

/** The object types the backfill loads, one job each. Older invoices follow the last 12 months (invoices_older). */
export const BACKFILL_OBJECTS = ["products", "prices", "coupons", "customers", "subscriptions", "invoices", "charges", "refunds"] as const;
export const OLDER_INVOICES = "invoices_older";
export type BackfillObject = (typeof BACKFILL_OBJECTS)[number] | typeof OLDER_INVOICES;
