// The live feed for one customer, from its movements, failed charges and refunds. Like the movements, it is
// rebuilt whole each time, and each item has a key that stays the same for the same event.
//   new → signup, expansion → upgrade, contraction → downgrade, churn → cancel, reactivation → reactivation:
//     amount is the MRR change (signed), at the moment of the change.
//   failed_payment: a failed charge. refund: a refund that succeeded or is pending. amount is the money (positive),
//     in workspace cents at that day's rate.

import { dayOf, dayText, parseDay, dayEnd } from "./days.ts";
import { convertCents, rateFinder } from "./fx.ts";
import { roundHalfAway, toNumber } from "./rational.ts";
import { uniqueById } from "./engine.ts";
import type { BuildResult, FeedItem, FeedKind, MovementKind, MrrInput } from "./types.ts";

const KIND: Record<MovementKind, FeedKind> = { new: "signup", expansion: "upgrade", contraction: "downgrade", churn: "cancel", reactivation: "reactivation" };

export function feedItems(input: MrrInput, result: BuildResult): FeedItem[] {
  const ws = input.currency.toLowerCase();
  const limit = dayEnd(parseDay(input.asOf));
  const rates = rateFinder(input.fx, ws);
  const out: FeedItem[] = [];

  for (const m of result.movements) {
    out.push({
      key: `${KIND[m.kind]}:${input.customerId}:${m.day}`,
      kind: KIND[m.kind],
      customerId: input.customerId,
      at: m.at,
      day: m.day,
      amount: m.amount,
      currency: ws,
      originalAmount: m.originalAmount,
      originalCurrency: m.originalCurrency,
      objectType: m.cause.type,
      objectId: m.cause.id,
    });
  }
  const money = (kind: FeedKind, objectType: "charge" | "refund", x: { id: string; created: number; amount: number; currency: string }) => {
    if (x.created > limit) return;
    const day = dayOf(x.created);
    const cur = x.currency.toLowerCase();
    out.push({
      key: `${kind}:${x.id}`,
      kind,
      customerId: input.customerId,
      at: x.created,
      day: dayText(day),
      amount: toNumber(roundHalfAway(convertCents(x.amount, rates(cur, day)))),
      currency: ws,
      originalAmount: x.amount,
      originalCurrency: cur,
      objectType,
      objectId: x.id,
    });
  };
  for (const c of uniqueById(input.charges)) if (c.status === "failed") money("failed_payment", "charge", c);
  for (const r of uniqueById(input.refunds)) if (r.status === "succeeded" || r.status === "pending") money("refund", "refund", r);

  return out.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
