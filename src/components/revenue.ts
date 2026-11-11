"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { metricOf, parseMovements, parseSeries, parseSummary, type MetricId, type MovementRow, type Point, type Summary } from "@/lib/metrics";
import { rangeFor, rangeFromQuery, rangeQuery, today, type Interval, type Preset, type Range } from "@/lib/ranges";
import { isHiccup, retryResult, withRetry } from "@/lib/retry";
import { parseSources, SOURCE_COLUMNS, type Source } from "./sourceState";
import { postJson, useLoad } from "./ui";

// What the dashboard, metric pages and Sources read: the workspace's sources and currency, and the read functions in
// 009_mrr.sql. Every read retries hiccups (src/lib/retry.ts) and throws a plain error for useLoad to show.

type Sb = Pick<SupabaseClient, "rpc" | "from">;

async function rpc<T>(sb: Sb, fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await retryResult(() => sb.rpc(fn, args));
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export type Sources = { sources: Source[]; currency: string };

/** The workspace's Stripe accounts (members' columns only) and the currency its MRR is counted in. */
export async function loadSources(sb: Sb, ws: string): Promise<Sources> {
  const [s, w] = await Promise.all([
    retryResult(() => sb.from("sources").select(SOURCE_COLUMNS).eq("workspace_id", ws).order("created_at", { ascending: true })),
    retryResult(() => sb.from("workspaces").select("currency").eq("id", ws).maybeSingle()),
  ]);
  if (s.error) throw new Error(s.error.message);
  if (w.error) throw new Error(w.error.message);
  const currency = (w.data as { currency?: unknown } | null)?.currency;
  return { sources: parseSources(s.data), currency: typeof currency === "string" && /^[a-z]{3}$/.test(currency) ? currency : "usd" };
}

/**
 * Sources, kept fresh: while an account is connecting or importing it's read again every 5 seconds, so the progress
 * line moves and the numbers open as soon as the import is done.
 */
export function useSources(sb: Sb, ws: string) {
  const load = useLoad(() => loadSources(sb, ws), ws, `sources:${ws}`);
  const busy = load.data?.sources.some((s) => s.status === "connecting" || s.status === "importing") ?? false;
  const { reload } = load;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(reload, 5_000);
    return () => clearInterval(t);
  }, [busy, reload]);
  return load;
}

export const loadSummary = async (sb: Sb, ws: string, r: Range): Promise<Summary> => parseSummary(await rpc(sb, "metric_summary", { p_ws: ws, p_from: r.from, p_to: r.to }));

export async function loadSeries(sb: Sb, ws: string, id: MetricId, r: { from: string; to: string }, interval: Interval, currency: string): Promise<Point[]> {
  const rows = await rpc<unknown>(sb, "metric_series", { p_ws: ws, p_metric: id, p_from: r.from, p_to: r.to, p_interval: interval });
  return parseSeries(metricOf(id)!, rows, currency);
}

export async function loadMovements(sb: Sb, ws: string, id: MetricId, r: { from: string; to: string }): Promise<MovementRow[]> {
  return parseMovements(await rpc(sb, "metric_movements", { p_ws: ws, p_metric: id, p_from: r.from, p_to: r.to }));
}

/** POST to our API with hiccups tried again; other errors come back at once with the route's own line. */
export const postRetry = <T>(path: string, body: object) => withRetry(() => postJson<T>(path, body, { timeoutMs: 20_000 }), { tries: 3, retryOn: (e) => isHiccup(e) });

/**
 * The date range in the address (?range=90d), so a card on the dashboard opens its metric over the same days and a
 * reload keeps them. Today is read once per page.
 */
export function useRange(): [Range, (preset: Preset, custom?: { from: string; to: string }) => void, string] {
  const [now] = useState(() => today());
  const [range, setRange] = useState<Range>(() => (typeof window === "undefined" ? rangeFor("30d", now) : rangeFromQuery(window.location.search, now)));
  const pick = useCallback(
    (preset: Preset, custom?: { from: string; to: string }) => {
      const r = rangeFor(preset, now, custom);
      setRange(r);
      const q = new URLSearchParams(window.location.search);
      for (const k of ["range", "from", "to"]) q.delete(k);
      for (const [k, v] of new URLSearchParams(rangeQuery(r))) q.set(k, v);
      const s = q.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${s ? `?${s}` : ""}`);
    },
    [now],
  );
  return [range, pick, now];
}

/** A query value kept in the address beside the range (?every=week, ?compare=1). */
export function setQuery(key: string, value: string | null) {
  const q = new URLSearchParams(window.location.search);
  if (value == null) q.delete(key);
  else q.set(key, value);
  const s = q.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${s ? `?${s}` : ""}`);
}
