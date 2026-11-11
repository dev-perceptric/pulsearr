"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useShell } from "@/components/AppShell";
import { MetricChart } from "@/components/Chart";
import { X } from "@/components/Icons";
import { RangePicker, rangeText } from "@/components/RangePicker";
import { loadMovements, loadSeries, setQuery, useRange, useSources } from "@/components/revenue";
import { lastSynced } from "@/components/sourceState";
import { Badge, Button, ErrorNote, IconButton, Page, Segmented, Switch, Td, Th, useLoad, WIDE } from "@/components/ui";
import { localDay, periodLabel } from "@/lib/chart";
import { fmtAgo, fmtDate, fmtMoneyExact, fmtNum, fromMinor } from "@/lib/format";
import { alignCompare, changeTone, fmtDelta, fmtPlotted, metricOf, MOVEMENT_LABEL, movementTone, plotValue, type MetricId, type MovementRow } from "@/lib/metrics";
import { retryResult } from "@/lib/retry";
import { compareLabel, defaultInterval, intervalFromQuery, intervalsFor, INTERVALS, periodEnd, previousRange, rangeQuery, type Interval } from "@/lib/ranges";

// One metric (docs/m1-plan.md section 5): its value for the range and the change from the period before, one chart
// (day, week or month; the previous period dashed when compared), and for the metrics made of MRR movements, the
// customers behind the change. A click on a period lists only that period's customers.

const PAGE = 50;

export function MetricScreen({ id }: { id: MetricId }) {
  const m = metricOf(id)!;
  const { sb, workspace } = useShell();
  const router = useRouter();
  const src = useSources(sb, workspace.id);
  const currency = src.data?.currency ?? null;
  const [range, setRange, now] = useRange();
  const [every, setEvery] = useState<Interval | null>(() => (typeof window === "undefined" ? null : intervalFromQuery(window.location.search, range)));
  const allowed = intervalsFor(range);
  const interval: Interval = every && allowed.includes(every) ? every : defaultInterval(range);
  const [compare, setCompare] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("compare") === "1");
  const [picked, setPicked] = useState<number | null>(null);
  const prev = previousRange(range);

  const key = `${range.from}:${range.to}:${interval}:${currency}`;
  const chart = useLoad(
    async () => {
      if (!currency) return null;
      const win = (r: { from: string; to: string }) =>
        retryResult(() => sb.rpc("metric_window", { p_ws: workspace.id, p_metric: id, p_from: r.from, p_to: r.to })).then((x) => {
          if (x.error) throw new Error(x.error.message);
          return plotValue(m, x.data, currency);
        });
      const [value, previous, series, before] = await Promise.all([win(range), win(prev), loadSeries(sb, workspace.id, id, range, interval, currency), loadSeries(sb, workspace.id, id, prev, interval, currency)]);
      return { value, previous, series, before };
    },
    key,
    `metric:${workspace.id}:${id}:${key}`,
  );
  const moves = useLoad(async () => (m.movements ? loadMovements(sb, workspace.id, id, range) : []), `${range.from}:${range.to}`, `movements:${workspace.id}:${id}:${range.from}:${range.to}`);

  const q = rangeQuery(range);
  const data = chart.data;
  const fmt = (v: number | null) => (currency ? fmtPlotted(m, v, currency) : "—");
  const tone = data ? changeTone(m, data.value, data.previous) : undefined;
  const synced = src.data ? lastSynced(src.data.sources) : null;
  const periods = data?.series.map((p) => p.period) ?? [];
  const pickedPeriod = picked != null ? periods[picked] : undefined;

  const pickRange: typeof setRange = (p, c) => {
    setPicked(null);
    setRange(p, c);
  };

  return (
    <Page
      title={m.label}
      crumbs={[{ label: "Dashboard", onClick: () => router.push(`/dashboard${q ? `?${q}` : ""}`) }]}
      actions={<RangePicker range={range} now={now} onChange={pickRange} />}
      toolbar={
        <>
          <Segmented
            label="Interval"
            value={interval}
            options={INTERVALS.filter((i) => allowed.includes(i.value))}
            onChange={(v) => {
              setEvery(v);
              setPicked(null);
              setQuery("every", v);
            }}
          />
          <label className="ml-auto flex items-center gap-2 text-[13px] text-ink">
            <Switch
              on={compare}
              label="Compare to previous period"
              onChange={(v) => {
                setCompare(v);
                setQuery("compare", v ? "1" : null);
              }}
            />
            Compare to previous period
          </label>
        </>
      }
    >
      <div className={`${WIDE} space-y-6`}>
        {!data ? (
          chart.error || src.error ? (
            <div className="space-y-3">
              <ErrorNote message={chart.error || src.error} />
              <Button
                variant="secondary"
                onClick={() => {
                  src.reload();
                  chart.reload();
                }}
              >
                Retry
              </Button>
            </div>
          ) : (
            <div className="space-y-6" role="status" aria-label="Loading">
              <span className="bone block h-12 w-48" />
              <span className="bone block h-[340px] w-full" />
            </div>
          )
        ) : (
          <>
            <div>
              <p className="font-serif text-[48px] leading-[52px] font-medium wrap-break-word text-ink tabular-nums">{fmt(data.value)}</p>
              {data.previous != null ? (
                <p className={`mt-2 text-[13px] leading-[18px] wrap-break-word tabular-nums ${tone === "green" ? "text-success" : tone === "red" ? "text-danger" : "text-muted"}`}>
                  {fmtDelta(m, data.value, data.previous, currency!)} vs. {compareLabel(range)}
                  <span className="text-muted"> ({fmt(data.previous)})</span>
                </p>
              ) : null}
            </div>
            <section className="border border-line bg-panel" aria-labelledby="metric-chart">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line px-6 py-4">
                <h2 id="metric-chart" className="text-[16px] leading-[22px] font-semibold">
                  {m.label}
                </h2>
                <p className="fig num">{rangeText(range)}</p>
                {compare ? <p className="fig num">Previous: {rangeText(prev)}</p> : null}
                <p className="fig ml-auto">From Stripe{synced ? `, updated ${fmtAgo(synced)}` : ""}</p>
              </div>
              <div className="px-4 py-5 md:px-6">
                <MetricChart
                  periods={periods}
                  values={data.series.map((p) => p.value)}
                  compare={compare ? alignCompare(data.series, data.before) : null}
                  comparePeriods={data.before.map((p) => p.period)}
                  bars={m.flow}
                  interval={interval}
                  format={fmt}
                  delta={(v, p) => ({ text: fmtDelta(m, v, p, currency!), tone: changeTone(m, v, p) })}
                  label={`${m.label} by ${interval}, ${rangeText(range)}: ${fmt(data.value)}, ${fmtDelta(m, data.value, data.previous, currency!)} vs. ${compareLabel(range)}.`}
                  onPick={m.movements ? (i) => setPicked((p) => (p === i ? null : i)) : undefined}
                  picked={picked}
                />
              </div>
            </section>
          </>
        )}
        {m.movements && currency ? (
          <Movements
            rows={moves.data}
            error={moves.error}
            onRetry={moves.reload}
            currency={currency}
            filter={pickedPeriod ? { from: pickedPeriod, to: periodEnd(pickedPeriod, interval), label: periodLabel(pickedPeriod, interval) } : null}
            onClear={() => setPicked(null)}
          />
        ) : null}
      </div>
    </Page>
  );
}

function Movements({ rows, error, onRetry, currency, filter, onClear }: { rows: MovementRow[] | null; error: string; onRetry: () => void; currency: string; filter: { from: string; to: string; label: string } | null; onClear: () => void }) {
  const [shown, setShown] = useState(PAGE);
  const list = useMemo(() => (rows ?? []).filter((r) => !filter || (r.day >= filter.from && r.day <= filter.to)), [rows, filter]);
  const code = currency.toUpperCase();
  const money = (n: number) => fmtMoneyExact(fromMinor(n, code), code);
  const signed = (n: number) => `${n > 0 ? "+" : ""}${money(n)}`;
  return (
    <section className="border border-line bg-panel" aria-labelledby="movers">
      <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-line px-6 py-3">
        <h2 id="movers" className="min-w-0 flex-1 text-[16px] leading-[22px] font-semibold wrap-break-word">
          Customers behind the change {rows ? <span className="text-[13px] font-normal text-muted tabular-nums">{fmtNum(list.length)}</span> : null}
        </h2>
        {filter ? (
          <span className="flex items-center gap-1">
            <Badge tone="brand">{filter.label}</Badge>
            <IconButton label="Show every period" onClick={onClear}>
              <X size={14} />
            </IconButton>
          </span>
        ) : null}
      </div>
      {!rows ? (
        error ? (
          <div className="space-y-3 p-6">
            <ErrorNote message={error} />
            <Button variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="space-y-3 p-6" role="status" aria-label="Loading">
            {[0, 1, 2].map((i) => (
              <span key={i} className="bone block h-3 w-full" />
            ))}
          </div>
        )
      ) : !list.length ? (
        <p className="px-6 py-8 text-[14px] text-muted">{filter ? "No customers moved in this period" : "No customers moved in this range"}</p>
      ) : (
        <>
          <ul className="md:hidden" aria-label="Customers">
            {list.slice(0, shown).map((r, i) => (
              <li key={`${r.source_id}:${r.customer_id}:${r.at}:${r.kind}:${i}`} className="space-y-1 border-b border-line px-4 py-3 last:border-b-0">
                <p className="text-[14px] leading-5 wrap-anywhere text-ink">{r.customer_name ?? r.customer_email ?? r.customer_id}</p>
                {r.customer_name && r.customer_email ? <p className="text-[12px] leading-4 wrap-anywhere text-muted">{r.customer_email}</p> : null}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
                  <span className="num text-[12px] leading-4 text-muted">{fmtDate(localDay(r.day))}</span>
                  <Badge tone={movementTone(r.kind)}>{MOVEMENT_LABEL[r.kind]}</Badge>
                  <span className={`num ml-auto text-[13px] leading-[18px] ${movementTone(r.kind) === "green" ? "text-success" : "text-danger"}`}>{signed(r.amount)}</span>
                </div>
                <p className="num text-right text-[12px] leading-4 text-muted">
                  {money(r.mrr_before)} → {money(r.mrr_after)}
                </p>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[640px] border-collapse">
              <thead>
                <tr>
                  <Th className="w-32">Date</Th>
                  <Th>Customer</Th>
                  <Th className="w-32">Movement</Th>
                  <Th className="w-36 text-right">Change</Th>
                  <Th className="w-56 text-right">MRR</Th>
                </tr>
              </thead>
              <tbody>
                {list.slice(0, shown).map((r, i) => (
                  <tr key={`${r.source_id}:${r.customer_id}:${r.at}:${r.kind}:${i}`} className="row-hover">
                    <Td className="num text-muted">{fmtDate(localDay(r.day))}</Td>
                    <Td>
                      <span className="block wrap-anywhere text-ink">{r.customer_name ?? r.customer_email ?? r.customer_id}</span>
                      {r.customer_name && r.customer_email ? <span className="block text-[12px] leading-4 wrap-anywhere text-muted">{r.customer_email}</span> : null}
                    </Td>
                    <Td>
                      <Badge tone={movementTone(r.kind)}>{MOVEMENT_LABEL[r.kind]}</Badge>
                    </Td>
                    <Td className={`num text-right ${movementTone(r.kind) === "green" ? "text-success" : "text-danger"}`}>{signed(r.amount)}</Td>
                    <Td className="num text-right text-muted">
                      {money(r.mrr_before)} → <span className="text-ink">{money(r.mrr_after)}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.length > shown ? (
            <div className="flex justify-center border-t border-line p-3">
              <Button variant="secondary" small onClick={() => setShown((n) => n + PAGE)}>
                Show more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
