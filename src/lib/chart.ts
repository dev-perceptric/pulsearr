// The math behind the hand-drawn charts (src/components/Chart.tsx): round axis steps, which dates get a label, how a
// series becomes an SVG path, and where the movement bars stack. Pure, so it's tested in Node.

import { fmtChartDate, fmtDate, fmtParts } from "./format.ts";
import type { Interval } from "./ranges.ts";

/** A round step near `raw`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return Number((m * p).toPrecision(12));
}

/**
 * Round axis ticks that cover [min, max] in about `count` steps. With `zero` (bars: docs/brand.md says bars start at
 * zero) the axis always holds zero; a line may start above it, and its lowest tick label then says where it starts.
 * Equal or empty input still gives a usable axis.
 */
export function niceTicks(min: number, max: number, count = 4, zero = true): number[] {
  const a = Number.isFinite(min) ? min : 0;
  const b = Number.isFinite(max) ? max : 0;
  let lo = zero ? Math.min(0, a) : Math.min(a, b);
  let hi = zero ? Math.max(0, b) : Math.max(a, b);
  if (lo === hi) {
    // One flat value: a band around it (or 0 to 1 at zero).
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1;
    hi = lo + pad;
    if (!zero && lo !== 0) lo -= pad;
  }
  const step = niceStep((hi - lo) / Math.max(1, count));
  lo = Math.floor(Number((lo / step).toPrecision(12))) * step;
  hi = Math.ceil(Number((hi / step).toPrecision(12))) * step;
  const out: number[] = [];
  for (let v = lo, i = 0; v <= hi + step / 2 && i < 50; v += step, i++) out.push(Number(v.toPrecision(12)) || 0);
  return out;
}

/** Which of `n` points get a date label: about `max` of them, evenly spaced, always the first, the last when it fits. */
export function labelIndices(n: number, max: number): number[] {
  if (n <= 0) return [];
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const every = Math.ceil((n - 1) / Math.max(1, max - 1));
  const out: number[] = [];
  for (let i = 0; i < n; i += every) out.push(i);
  const last = n - 1;
  // The last label goes in when it's far enough from the one before it, else it replaces it.
  if (out[out.length - 1] !== last) {
    if (last - out[out.length - 1]! >= every / 2) out.push(last);
    else out[out.length - 1] = last;
  }
  return out;
}

/** A day as a Date at local noon, so formatting it in any time zone shows the same calendar day. */
export function localDay(day: string): Date {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1, 12);
}

/** An axis label for a period's first day: "Nov 3" for days and weeks, "Nov '26" for months. */
export const axisDate = (day: string, interval: Interval) => fmtChartDate(localDay(day), interval === "month" ? "month" : "day");

/** A period in a tooltip: "Nov 3, 2026", "Week of Nov 3, 2026", "November 2026". */
export function periodLabel(day: string, interval: Interval): string {
  const d = localDay(day);
  if (interval === "day") return fmtDate(d);
  if (interval === "week") return `Week of ${fmtDate(d)}`;
  return fmtParts(d, { month: "long", year: "numeric" });
}

/** A linear scale from a domain onto pixels. */
export const scale = (d0: number, d1: number, r0: number, r1: number) => (v: number) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));

/** An SVG path through the points; a null value breaks the line. Coordinates rounded to tenths. */
export function linePath(xs: number[], ys: (number | null)[]): string {
  let d = "";
  let open = false;
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i];
    if (y == null || !Number.isFinite(y)) {
      open = false;
      continue;
    }
    d += `${open ? "L" : "M"}${r1(xs[i]!)} ${r1(y)}`;
    open = true;
  }
  return d;
}

/** The same line closed down to `base`, for the 8% area fill. One shape per unbroken run. */
export function areaPath(xs: number[], ys: (number | null)[], base: number): string {
  let d = "";
  let run: number[] = [];
  const flush = () => {
    if (run.length > 1) {
      d += `M${r1(xs[run[0]!]!)} ${r1(base)}` + run.map((i) => `L${r1(xs[i]!)} ${r1(ys[i]!)}`).join("") + `L${r1(xs[run[run.length - 1]!]!)} ${r1(base)}Z`;
    }
    run = [];
  };
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i];
    if (y == null || !Number.isFinite(y)) flush();
    else run.push(i);
  }
  flush();
  return d;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Bar slots: each bar gets a slot, and the bar is 80% of it, so the gap is 25% of the bar's width (docs/brand.md). */
export function barGeometry(width: number, n: number): { slot: number; bar: number } {
  const slot = n > 0 ? width / n : width;
  return { slot, bar: Math.max(1, slot * 0.8) };
}

export type Segment = { key: string; from: number; to: number };

/**
 * Stacks one period's movements: positives from zero up in the order given, negatives from zero down. Values are
 * signed (contraction and churn negative). Zero values take no room.
 */
export function stack(values: { key: string; value: number | null }[]): Segment[] {
  let up = 0;
  let down = 0;
  const out: Segment[] = [];
  for (const v of values) {
    const n = v.value ?? 0;
    if (n > 0) {
      out.push({ key: v.key, from: up, to: up + n });
      up += n;
    } else if (n < 0) {
      out.push({ key: v.key, from: down, to: down + n });
      down += n;
    }
  }
  return out;
}

/** The index of the point nearest to x, for hover and the keyboard. */
export function nearestIndex(xs: number[], x: number): number {
  if (!xs.length) return -1;
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i]! - x) < Math.abs(xs[best]! - x)) best = i;
  return best;
}
