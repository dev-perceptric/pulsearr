// The 17 metrics of M1 (docs/m1-plan.md section 5) as the screens show them: name, how the value prints, whether up
// is good, bars or a line, and whether a table of customers sits under the chart. Values come from the read
// functions in 009_mrr.sql: money in minor units (cents) of the workspace currency, rates as fractions. Pure, so it's
// tested in Node.

import { fmtChange, fmtMoney, fmtMoneyChange, fmtNum, fmtPercent, fromMinor, MINUS } from "./format.ts";

export type MetricId =
  | "mrr"
  | "arr"
  | "net_new_mrr"
  | "new_mrr"
  | "expansion_mrr"
  | "reactivation_mrr"
  | "contraction_mrr"
  | "churned_mrr"
  | "active_customers"
  | "new_customers"
  | "arpu"
  | "customer_churn_rate"
  | "revenue_churn_rate"
  | "nrr"
  | "grr"
  | "ltv"
  | "quick_ratio";

export type Unit = "money" | "count" | "percent" | "ratio";

export type Metric = {
  id: MetricId;
  label: string;
  unit: Unit;
  /** Whether a rise is good for the business (churn falling is good). */
  upIsGood: boolean;
  /** A sum over each period (bars), or a level or rate at each period (a line). */
  flow: boolean;
  /** The metric page lists the customers behind the change. */
  movements: boolean;
};

const M = (id: MetricId, label: string, unit: Unit, o: { down?: boolean; flow?: boolean; movements?: boolean } = {}): Metric => ({
  id,
  label,
  unit,
  upIsGood: !o.down,
  flow: o.flow ?? false,
  movements: o.movements ?? true,
});

export const METRICS: Metric[] = [
  M("mrr", "MRR", "money"),
  M("arr", "ARR", "money"),
  M("net_new_mrr", "Net new MRR", "money", { flow: true }),
  M("new_mrr", "New MRR", "money", { flow: true }),
  M("expansion_mrr", "Expansion MRR", "money", { flow: true }),
  M("reactivation_mrr", "Reactivation MRR", "money", { flow: true }),
  M("contraction_mrr", "Contraction MRR", "money", { flow: true, down: true }),
  M("churned_mrr", "Churned MRR", "money", { flow: true, down: true }),
  M("active_customers", "Active customers", "count"),
  M("new_customers", "New customers", "count", { flow: true }),
  M("arpu", "ARPU", "money", { movements: false }),
  M("customer_churn_rate", "Customer churn rate", "percent", { down: true }),
  M("revenue_churn_rate", "Revenue churn rate", "percent", { down: true }),
  M("nrr", "NRR", "percent"),
  M("grr", "GRR", "percent"),
  M("ltv", "LTV", "money", { movements: false }),
  M("quick_ratio", "Quick ratio", "ratio", { movements: false }),
];

const BY_ID = new Map(METRICS.map((m) => [m.id as string, m]));
export const metricOf = (id: string): Metric | null => BY_ID.get(id) ?? null;

/** The key numbers on the dashboard, in order. */
export const DASHBOARD_METRICS: MetricId[] = ["mrr", "arr", "net_new_mrr", "active_customers", "customer_churn_rate", "revenue_churn_rate", "arpu", "ltv"];

/** The five movement bars under the MRR line: good ones stack above zero, bad ones below. */
export const MOVEMENTS = [
  { id: "new_mrr", kind: "new", label: "New", good: true },
  { id: "expansion_mrr", kind: "expansion", label: "Expansion", good: true },
  { id: "reactivation_mrr", kind: "reactivation", label: "Reactivation", good: true },
  { id: "contraction_mrr", kind: "contraction", label: "Contraction", good: false },
  { id: "churned_mrr", kind: "churn", label: "Churn", good: false },
] as const satisfies readonly { id: MetricId; kind: string; label: string; good: boolean }[];

/** A number from PostgREST (numeric can arrive as a string), or null. */
export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The value as the chart draws it: whole currency units for money, the fraction for rates, the count for counts. */
export function plotValue(m: Metric, raw: unknown, currency: string): number | null {
  const n = num(raw);
  if (n == null) return null;
  return m.unit === "money" ? fromMinor(n, currency) : n;
}

/** A plotted value as text: "$48.2K", "1,284", "3.4%", "2.4". */
export function fmtPlotted(m: Metric, v: number | null | undefined, currency: string): string {
  if (m.unit === "money") return fmtMoney(v, currency.toUpperCase());
  if (m.unit === "percent") return fmtPercent(v);
  if (m.unit === "ratio") return fmtNum(v, 1);
  return fmtNum(v, 0);
}

/** A raw value (cents, fraction or count) as text. */
export const fmtMetric = (m: Metric, raw: unknown, currency: string) => fmtPlotted(m, plotValue(m, raw, currency), currency);

/** A change between two plotted values, signed: "+12.3%" when the start isn't zero, else "+$1.2K" or "+12". */
export function fmtDelta(m: Metric, value: number | null, previous: number | null, currency: string): string {
  if (value == null || previous == null) return "—";
  const change = value - previous;
  if (previous !== 0) return fmtChange(change / Math.abs(previous));
  if (m.unit === "money") return fmtMoneyChange(change, currency.toUpperCase());
  if (change === 0) return m.unit === "percent" ? "0.0%" : "0";
  const text = m.unit === "percent" ? fmtPercent(Math.abs(change)) : fmtNum(Math.abs(change), m.unit === "ratio" ? 1 : 0);
  return `${change < 0 ? MINUS : "+"}${text}`;
}

/** What a change means for the business: green, red, or plain when nothing changed or it can't be told. */
export function changeTone(m: Metric, value: number | null, previous: number | null): "green" | "red" | undefined {
  if (value == null || previous == null || value === previous) return undefined;
  return value > previous === m.upIsGood ? "green" : "red";
}

export type SummaryRow = { metric: string; value: unknown; previous: unknown; change?: unknown; change_pct?: unknown };
export type Summary = Partial<Record<MetricId, { value: number | null; previous: number | null }>>;

/** metric_summary's rows, keyed by metric, numbers checked. Unknown metrics drop out. */
export function parseSummary(rows: unknown): Summary {
  const out: Summary = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows as SummaryRow[]) {
    const m = r && typeof r === "object" ? metricOf(String(r.metric)) : null;
    if (m) out[m.id] = { value: num(r.value), previous: num(r.previous) };
  }
  return out;
}

export type Point = { period: string; value: number | null };

/** metric_series' rows in date order, plotted (money in whole units). Rows without a day drop out. */
export function parseSeries(m: Metric, rows: unknown, currency: string): Point[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is { period: string; value: unknown } => Boolean(r) && typeof r.period === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.period))
    .map((r) => ({ period: r.period.slice(0, 10), value: plotValue(m, r.value, currency) }))
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
}

/** Lines the previous period up under the current one, period by period from the start; the extra ones are null. */
export function alignCompare(current: Point[], previous: Point[]): (number | null)[] {
  return current.map((_, i) => previous[i]?.value ?? null);
}

export type MovementRow = {
  day: string;
  at: string;
  source_id: string;
  customer_id: string;
  customer_name: string | null;
  customer_email: string | null;
  kind: "new" | "expansion" | "reactivation" | "contraction" | "churn";
  amount: number;
  mrr_before: number;
  mrr_after: number;
  currency: string;
};

const KINDS = new Set(["new", "expansion", "reactivation", "contraction", "churn"]);

/** metric_movements' rows, checked; a malformed row drops out rather than drawing a broken line. */
export function parseMovements(rows: unknown): MovementRow[] {
  if (!Array.isArray(rows)) return [];
  const out: MovementRow[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || typeof r.day !== "string" || typeof r.customer_id !== "string" || !KINDS.has(String(r.kind))) continue;
    const amount = num(r.amount);
    const before = num(r.mrr_before);
    const after = num(r.mrr_after);
    if (amount == null || before == null || after == null) continue;
    out.push({
      day: r.day.slice(0, 10),
      at: typeof r.at === "string" ? r.at : r.day,
      source_id: String(r.source_id ?? ""),
      customer_id: r.customer_id,
      customer_name: typeof r.customer_name === "string" && r.customer_name ? r.customer_name : null,
      customer_email: typeof r.customer_email === "string" && r.customer_email ? r.customer_email : null,
      kind: r.kind as MovementRow["kind"],
      amount,
      mrr_before: before,
      mrr_after: after,
      currency: typeof r.currency === "string" ? r.currency : "usd",
    });
  }
  return out;
}

export const MOVEMENT_LABEL: Record<MovementRow["kind"], string> = { new: "New", expansion: "Expansion", reactivation: "Reactivation", contraction: "Contraction", churn: "Churn" };
export const movementTone = (k: MovementRow["kind"]): "green" | "red" => (k === "contraction" || k === "churn" ? "red" : "green");
