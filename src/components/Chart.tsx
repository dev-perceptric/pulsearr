"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { areaPath, axisDate, barGeometry, labelIndices, linePath, nearestIndex, niceTicks, periodLabel, scale, stack } from "@/lib/chart";
import type { Interval } from "@/lib/ranges";
import { Floating } from "./Floating";

// The hand-drawn charts (docs/brand.md section 10): square, navy lines and bars, pulse blue for the current value
// only, the previous period as a dashed sky line, gridlines in hover gray, axis labels in muted through format.ts.
// Hover (or the arrow keys once focused) shows one tooltip on the floating layer with the date, each value and the
// change. Each chart is an image with a spoken summary.

/** The width of a box, kept up to date as it resizes. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const PAD = { left: 60, right: 12, top: 12, bottom: 28 };

type Hover = { i: number; x: number; y: number } | null;

/** Hover and arrow-key focus over a row of points. */
function useHover(xs: number[], top: number) {
  const [hover, setHover] = useState<Hover>(null);
  const at = (i: number) => (i >= 0 && i < xs.length ? { i, x: xs[i]!, y: top } : null);
  const handlers = {
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      const i = nearestIndex(xs, e.clientX - r.left);
      if (i !== hover?.i) setHover(at(i));
    },
    onPointerLeave: () => setHover(null),
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End" && e.key !== "Escape") return;
    e.preventDefault();
    if (e.key === "Escape") return setHover(null);
    const last = xs.length - 1;
    const cur = hover?.i ?? (e.key === "ArrowLeft" ? last + 1 : -1);
    const next = e.key === "Home" ? 0 : e.key === "End" ? last : Math.max(0, Math.min(last, cur + (e.key === "ArrowLeft" ? -1 : 1)));
    setHover(at(next));
  };
  return { hover, setHover, handlers, keys };
}

/** The tooltip, on the floating layer, above the point being looked at. */
function ChartTip({ hover, children }: { hover: NonNullable<Hover>; children: React.ReactNode }) {
  const mark = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span ref={mark} aria-hidden="true" className="pointer-events-none absolute size-px" style={{ left: hover.x, top: hover.y }} />
      <Floating anchor={mark} placement="top" gap={8} passive role="tooltip" track={`${hover.x}:${hover.y}`} className="min-w-44 rounded-md border border-line bg-panel px-3 py-2.5 text-[12px] leading-4 text-ink shadow-pop">
        {children}
      </Floating>
    </>
  );
}

/** One row in a tooltip: a swatch, the name, the value on the right. */
export function TipRow({ swatch, label, value, tone }: { swatch?: React.ReactNode; label: string; value: string; tone?: "green" | "red" }) {
  return (
    <div className="flex min-w-0 items-center gap-2 py-0.5">
      {swatch ?? null}
      <span className="min-w-0 flex-1 wrap-break-word text-muted">{label}</span>
      <span className={`num font-medium ${tone === "green" ? "text-success" : tone === "red" ? "text-danger" : "text-ink"}`}>{value}</span>
    </div>
  );
}

const DeltaRow = ({ d }: { d: { text: string; tone?: "green" | "red" } }) => <TipRow label="Change" value={d.text} tone={d.tone} />;

/** A small square in a series' color, for tooltips and legends. */
export function Swatch({ className, dashed = false }: { className: string; dashed?: boolean }) {
  return dashed ? <span aria-hidden="true" className={`inline-block h-0 w-3 shrink-0 border-t-2 border-dashed ${className}`} /> : <span aria-hidden="true" className={`inline-block size-2.5 shrink-0 ${className}`} />;
}

function YAxis({ ticks, y, width, format }: { ticks: number[]; y: (v: number) => number; width: number; format: (v: number) => string }) {
  return (
    <g aria-hidden="true">
      {ticks.map((t, i) => (
        <g key={t}>
          <line x1={PAD.left} x2={width - PAD.right} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} className={t === 0 || i === 0 ? "stroke-line-strong" : "stroke-hover"} strokeWidth={1} />
          <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
            {format(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

function XAxis({ periods, xs, width, height, interval }: { periods: string[]; xs: number[]; width: number; height: number; interval: Interval }) {
  const plot = width - PAD.left - PAD.right;
  const idx = labelIndices(periods.length, Math.max(2, Math.floor(plot / 76)));
  return (
    <g aria-hidden="true">
      {idx.map((i) => (
        <text key={i} x={xs[i]} y={height - 8} textAnchor={idx.length > 1 && i === idx[idx.length - 1] && xs[i]! > width - 40 ? "end" : "middle"} className="fill-muted text-[11px] tabular-nums">
          {axisDate(periods[i]!, interval)}
        </text>
      ))}
    </g>
  );
}

const centers = (n: number, width: number) => {
  const { slot } = barGeometry(Math.max(0, width - PAD.left - PAD.right), n);
  return Array.from({ length: n }, (_, i) => PAD.left + slot * (i + 0.5));
};

const lastIndex = (values: (number | null)[]) => {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return i;
  return -1;
};

export type MetricChartProps = {
  /** Each period's first day. */
  periods: string[];
  values: (number | null)[];
  /** The previous period, lined up period by period, drawn as a dashed line. */
  compare?: (number | null)[] | null;
  comparePeriods?: string[];
  bars: boolean;
  interval: Interval;
  format: (v: number | null) => string;
  /** The change from the previous period's value, for the tooltip. */
  delta?: (v: number | null, prev: number | null) => { text: string; tone?: "green" | "red" };
  /** The spoken summary. */
  label: string;
  height?: number;
  /** A click on a period (opens the customers behind it). */
  onPick?: (i: number) => void;
  picked?: number | null;
};

/** One metric over time: bars for a sum per period, a line for a level or a rate. */
export function MetricChart({ periods, values, compare, comparePeriods, bars, interval, format, delta, label, height = 280, onPick, picked = null }: MetricChartProps) {
  const [box, width] = useWidth<HTMLDivElement>();
  const n = periods.length;
  const xs = centers(n, width);
  const all = [...values, ...(compare ?? [])].filter((v): v is number => v != null);
  const ticks = niceTicks(all.length ? Math.min(...all) : 0, all.length ? Math.max(...all) : 0, 4, bars);
  const y = scale(ticks[0]!, ticks[ticks.length - 1]!, height - PAD.bottom, PAD.top);
  const { hover, handlers, keys } = useHover(xs, PAD.top);
  const { bar } = barGeometry(Math.max(0, width - PAD.left - PAD.right), n);
  const current = lastIndex(values);
  // Bars grow from zero; a line's area fills down to the bottom of the axis.
  const y0 = bars ? y(0) : y(ticks[0]!);
  const ys = values.map((v) => (v == null ? null : y(v)));
  const shown = hover?.i ?? null;

  return (
    <div ref={box} className="relative w-full" tabIndex={n ? 0 : -1} onKeyDown={keys} role="group">
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label={label} overflow="visible" className={`block select-none ${onPick ? "cursor-pointer" : ""}`} {...handlers} onClick={(e) => onPick && n && onPick(nearestIndex(xs, e.clientX - e.currentTarget.getBoundingClientRect().left))}>
          <YAxis ticks={ticks} y={y} width={width} format={(v) => format(v)} />
          {shown != null ? <line x1={xs[shown]} x2={xs[shown]} y1={PAD.top} y2={height - PAD.bottom} className="stroke-line-strong" strokeWidth={1} aria-hidden="true" /> : null}
          {bars ? (
            <g aria-hidden="true">
              {values.map((v, i) =>
                v == null || v === 0 ? null : (
                  <rect
                    key={i}
                    x={xs[i]! - bar / 2}
                    width={bar}
                    y={Math.min(y(v), y0)}
                    height={Math.max(1, Math.abs(y(v) - y0))}
                    className={i === current ? "fill-brand" : "fill-navy"}
                    opacity={picked != null && picked !== i ? 0.35 : 1}
                  />
                ),
              )}
            </g>
          ) : (
            <g aria-hidden="true">
              <path d={areaPath(xs, ys, y0)} className="fill-navy" opacity={0.08} />
              <path d={linePath(xs, ys)} className="fill-none stroke-navy" strokeWidth={2} strokeLinejoin="miter" strokeLinecap="square" />
            </g>
          )}
          {compare ? <path d={linePath(xs, compare.map((v) => (v == null ? null : y(v))))} aria-hidden="true" className="fill-none stroke-sky" strokeWidth={2} strokeDasharray="4 4" strokeLinejoin="miter" /> : null}
          {!bars && current >= 0 ? <rect x={xs[current]! - 4} y={ys[current]! - 4} width={8} height={8} className="fill-brand" aria-hidden="true" /> : null}
          {!bars && shown != null && shown !== current && ys[shown] != null ? <rect x={xs[shown]! - 3} y={ys[shown]! - 3} width={6} height={6} className="fill-navy" aria-hidden="true" /> : null}
          {!bars && picked != null && ys[picked] != null ? <rect x={xs[picked]! - 5} y={ys[picked]! - 5} width={10} height={10} className="fill-none stroke-brand" strokeWidth={2} aria-hidden="true" /> : null}
          <XAxis periods={periods} xs={xs} width={width} height={height} interval={interval} />
        </svg>
      ) : (
        <div style={{ height }} />
      )}
      {hover ? (
        <ChartTip hover={hover}>
          <p className="mb-1.5 font-medium">{periodLabel(periods[hover.i]!, interval)}</p>
          <TipRow swatch={<Swatch className={hover.i === current ? "bg-brand" : "bg-navy"} />} label="This period" value={format(values[hover.i] ?? null)} />
          {compare ? (
            <>
              <TipRow swatch={<Swatch className="border-sky" dashed />} label={comparePeriods?.[hover.i] ? periodLabel(comparePeriods[hover.i]!, interval) : "Previous period"} value={format(compare[hover.i] ?? null)} />
              {delta ? <DeltaRow d={delta(values[hover.i] ?? null, compare[hover.i] ?? null)} /> : null}
            </>
          ) : null}
        </ChartTip>
      ) : null}
    </div>
  );
}

export type MovementSeries = { key: string; label: string; good: boolean; values: (number | null)[] };

// Shades within green and red tell the kinds apart; the color says good or bad.
const SHADE: Record<string, number> = { new: 1, expansion: 0.7, reactivation: 0.45, contraction: 0.55, churn: 1 };
const shadeOf = (key: string) => SHADE[key] ?? 1;

/** The MRR line over its five movement bars (good above zero, bad below) and the net line in ink, one hover for both. */
export function MrrChart({ periods, mrr, movements, net, interval, format, label }: { periods: string[]; mrr: (number | null)[]; movements: MovementSeries[]; net: (number | null)[]; interval: Interval; format: (v: number | null) => string; label: string }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const n = periods.length;
  const xs = centers(n, width);
  const topH = 220;
  const barH = 170;
  const gap = 8;
  const { hover, handlers, keys } = useHover(xs, PAD.top);

  // The MRR line.
  const mrrVals = mrr.filter((v): v is number => v != null);
  const t1 = niceTicks(mrrVals.length ? Math.min(...mrrVals) : 0, mrrVals.length ? Math.max(...mrrVals) : 0, 4, false);
  const y1 = scale(t1[0]!, t1[t1.length - 1]!, topH - 16, PAD.top);
  const ys = mrr.map((v) => (v == null ? null : y1(v)));
  const current = lastIndex(mrr);

  // The movements, stacked per period.
  const stacks = periods.map((_, i) => stack(movements.map((m) => ({ key: m.key, value: m.values[i] ?? null }))));
  const ends = stacks.flatMap((s) => s.flatMap((g) => [g.from, g.to])).concat(net.filter((v): v is number => v != null));
  const t2 = niceTicks(Math.min(0, ...ends), Math.max(0, ...ends), 4);
  const top2 = topH + gap;
  const y2 = scale(t2[0]!, t2[t2.length - 1]!, top2 + barH - PAD.bottom, top2 + PAD.top);
  const { bar } = barGeometry(Math.max(0, width - PAD.left - PAD.right), n);
  const height = top2 + barH;
  const good = new Map(movements.map((m) => [m.key, m.good]));

  return (
    <div ref={box} className="relative w-full" tabIndex={n ? 0 : -1} onKeyDown={keys} role="group">
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label={label} overflow="visible" className="block select-none" {...handlers}>
          <YAxis ticks={t1} y={y1} width={width} format={(v) => format(v)} />
          <YAxis ticks={t2} y={y2} width={width} format={(v) => format(v)} />
          {hover ? <line x1={hover.x} x2={hover.x} y1={PAD.top} y2={height - PAD.bottom} className="stroke-line-strong" strokeWidth={1} aria-hidden="true" /> : null}
          <g aria-hidden="true">
            <path d={areaPath(xs, ys, y1(t1[0]!))} className="fill-navy" opacity={0.08} />
            <path d={linePath(xs, ys)} className="fill-none stroke-navy" strokeWidth={2} strokeLinejoin="miter" strokeLinecap="square" />
            {current >= 0 ? <rect x={xs[current]! - 4} y={ys[current]! - 4} width={8} height={8} className="fill-brand" /> : null}
            {hover && hover.i !== current && ys[hover.i] != null ? <rect x={xs[hover.i]! - 3} y={ys[hover.i]! - 3} width={6} height={6} className="fill-navy" /> : null}
          </g>
          <g aria-hidden="true">
            {stacks.map((segs, i) =>
              segs.map((s) => (
                <rect
                  key={`${i}:${s.key}`}
                  x={xs[i]! - bar / 2}
                  width={bar}
                  y={Math.min(y2(s.from), y2(s.to))}
                  height={Math.max(1, Math.abs(y2(s.to) - y2(s.from)))}
                  className={good.get(s.key) ? "fill-success" : "fill-danger"}
                  opacity={shadeOf(s.key)}
                />
              )),
            )}
            <path d={linePath(xs, net.map((v) => (v == null ? null : y2(v))))} className="fill-none stroke-ink" strokeWidth={2} strokeLinejoin="miter" />
          </g>
          <XAxis periods={periods} xs={xs} width={width} height={height} interval={interval} />
        </svg>
      ) : (
        <div style={{ height: topH + gap + barH }} />
      )}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 pl-[60px] text-[12px] leading-4 text-muted max-sm:pl-0" aria-label="Legend">
        <li className="flex items-center gap-1.5">
          <Swatch className="bg-navy" />
          MRR
        </li>
        {movements.map((m) => (
          <li key={m.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`inline-block size-2.5 shrink-0 ${m.good ? "bg-success" : "bg-danger"}`} style={{ opacity: shadeOf(m.key) }} />
            {m.label}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-0.5 w-3 shrink-0 bg-ink" />
          Net
        </li>
      </ul>
      {hover ? (
        <ChartTip hover={hover}>
          <p className="mb-1.5 font-medium">{periodLabel(periods[hover.i]!, interval)}</p>
          <TipRow swatch={<Swatch className={hover.i === current ? "bg-brand" : "bg-navy"} />} label="MRR" value={format(mrr[hover.i] ?? null)} />
          {movements.map((m) => (
            <TipRow key={m.key} swatch={<span aria-hidden="true" className={`inline-block size-2.5 shrink-0 ${m.good ? "bg-success" : "bg-danger"}`} style={{ opacity: shadeOf(m.key) }} />} label={m.label} value={format(m.values[hover.i] ?? null)} />
          ))}
          <TipRow swatch={<span aria-hidden="true" className="inline-block h-0.5 w-2.5 shrink-0 bg-ink" />} label="Net" value={format(net[hover.i] ?? null)} tone={(net[hover.i] ?? 0) > 0 ? "green" : (net[hover.i] ?? 0) < 0 ? "red" : undefined} />
        </ChartTip>
      ) : null}
    </div>
  );
}

/** The tiny line at the bottom of a number card: 32px tall, no axes, the current value as a pulse-blue square. */
export function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const h = 32;
  const pts = values.filter((v): v is number => v != null);
  const lo = pts.length ? Math.min(...pts) : 0;
  const hi = pts.length ? Math.max(...pts) : 0;
  const n = values.length;
  const xs = values.map((_, i) => (n <= 1 ? width / 2 : 3 + ((width - 6) * i) / (n - 1)));
  const y = scale(lo, hi, h - 4, 4);
  const ys = values.map((v) => (v == null ? null : y(v)));
  const cur = lastIndex(values);
  return (
    <div ref={box} className="h-8 w-full">
      {width > 0 && pts.length ? (
        <svg width={width} height={h} role="img" aria-label={label} className="block" overflow="visible">
          <path d={linePath(xs, ys)} className="fill-none stroke-navy" strokeWidth={1.5} strokeLinejoin="miter" />
          {cur >= 0 ? <rect x={xs[cur]! - 2.5} y={ys[cur]! - 2.5} width={5} height={5} className="fill-brand" /> : null}
        </svg>
      ) : null}
    </div>
  );
}
