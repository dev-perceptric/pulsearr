// The MRR engine (docs/m1-plan.md section 3). Pure TypeScript that Node runs directly, for the tests and the worker.
//
//   fromStripe(data, { currency, asOf, fx })  Stripe objects for one customer → MrrInput
//   buildCustomer(input)                       → { mrr, segments, days, movements }
//   feedItems(input, result)                   → the customer's live feed items

export { buildCustomer, monthlyFactor, periodAmount, uniqueById, MissingDataError, MRR_FIELDS, UNPAID_CHURN_DAYS } from "./engine.ts";
export { feedItems } from "./feed.ts";
export { rateFinder, MissingRateError, MAX_STALE_DAYS } from "./fx.ts";
export { fromStripe, mapCoupon, mapPrice, referencedIds, type StripeData } from "./stripe.ts";
export { dayText, parseDay, dayOf } from "./days.ts";
export type * from "./types.ts";
