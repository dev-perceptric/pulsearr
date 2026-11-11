"use client";

import Link from "next/link";
import { useShell } from "@/components/AppShell";
import { MrrChart, Sparkline } from "@/components/Chart";
import { ConnectStripe } from "@/components/ConnectStripe";
import { Loader } from "@/components/Loader";
import { RangePicker, rangeText } from "@/components/RangePicker";
import { loadSeries, loadSummary, useRange, useSources } from "@/components/revenue";
import { isAdmin } from "@/components/shellState";
import { dashboardState, importProgress, lastSynced, type Source } from "@/components/sourceState";
import { ToolIntro } from "@/components/ToolIntro";
import { buttonClass, Button, Empty, ErrorNote, Page, useLoad, WIDE } from "@/components/ui";
import { fmtAgo } from "@/lib/format";
import { changeTone, DASHBOARD_METRICS, fmtDelta, fmtPlotted, metricOf, MOVEMENTS, plotValue, type MetricId, type Point, type Summary } from "@/lib/metrics";
import { plainError } from "@/lib/plainError";
import { compareLabel, defaultInterval, rangeQuery, type Range } from "@/lib/ranges";

// The dashboard (docs/m1-plan.md section 5): before Stripe is connected, the first screen with "Connect Stripe";
// during the first import, one progress line; after it, the key numbers with their change and trend, and the MRR line
// over its five movement bars, for the range picked at the top.

export function DashboardScreen() {
  const { sb, workspace } = useShell();
  const src = useSources(sb, workspace.id);
  const [range, setRange, now] = useRange();
  const state = src.data ? dashboardState(src.data.sources) : null;

  return (
    <Page title="Dashboard" actions={state === "live" ? <RangePicker range={range} now={now} onChange={setRange} /> : undefined}>
      {!src.data ? (
        src.error ? (
          <Retry message={src.error} onRetry={src.reload} />
        ) : (
          <CardsSkeleton />
        )
      ) : state === "none" ? (
        <ToolIntro
          drawing="revenue"
          title="Connect Stripe to see your MRR"
          lead={isAdmin(workspace.role) ? "Read-only access. First numbers in about 60 seconds." : "Ask an owner or admin to connect Stripe."}
          action={isAdmin(workspace.role) ? <ConnectStripe /> : undefined}
        />
      ) : state === "importing" ? (
        <Importing sources={src.data.sources} />
      ) : state === "error" ? (
        <Empty
          drawing="revenue"
          title="Stripe needs a look"
          action={
            <Link href="/settings/sources" className={buttonClass("primary")}>
              Open Sources
            </Link>
          }
        >
          {plainError(src.data.sources.find((s) => s.last_error)?.last_error ?? "", "The import stopped. Open Sources to connect again.")}
        </Empty>
      ) : (
        <Live range={range} currency={src.data.currency} sources={src.data.sources} />
      )}
    </Page>
  );
}

function Retry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={`${WIDE} space-y-3`}>
      <ErrorNote message={message} />
      <Button variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function Importing({ sources }: { sources: Source[] }) {
  const busy = sources.filter((s) => s.status === "importing" || s.status === "connecting");
  const text = busy
    .map((s) => importProgress(s.backfill).text)
    .filter(Boolean)
    .join(", ");
  return (
    <Empty drawing="revenue" title="Importing from Stripe">
      <p className="num flex items-start justify-center gap-2" role="status">
        <Loader size={4} className="mt-1.5 text-brand" />
        <span className="min-w-0">{text || "Reading your Stripe account"}</span>
      </p>
    </Empty>
  );
}

type Board = { summary: Summary; series: Partial<Record<MetricId, Point[]>> };

const SERIES: MetricId[] = [...new Set<MetricId>([...DASHBOARD_METRICS, ...MOVEMENTS.map((m) => m.id)])];

function Live({ range, currency, sources }: { range: Range; currency: string; sources: Source[] }) {
  const { sb, workspace } = useShell();
  const interval = defaultInterval(range);
  const key = `${range.from}:${range.to}:${interval}`;
  const { data, error, reload } = useLoad<Board>(
    async () => {
      const [summary, ...lists] = await Promise.all([loadSummary(sb, workspace.id, range), ...SERIES.map((id) => loadSeries(sb, workspace.id, id, range, interval, currency))]);
      return { summary, series: Object.fromEntries(SERIES.map((id, i) => [id, lists[i]])) };
    },
    key,
    `dashboard:${workspace.id}:${key}:${currency}`,
  );
  const broken = sources.filter((s) => s.status === "error");
  const synced = lastSynced(sources);
  const q = rangeQuery(range);
  const mrr = metricOf("mrr")!;
  const money = (v: number | null) => fmtPlotted(mrr, v, currency);

  return (
    <div className={`${WIDE} space-y-6`}>
      {broken.length ? (
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <ErrorNote message={`${broken.map((s) => s.account_name ?? s.account_id).join(", ")} stopped syncing.`} />
          </div>
          <Link href="/settings/sources" className={buttonClass("secondary")}>
            Open Sources
          </Link>
        </div>
      ) : null}
      {!data ? (
        error ? (
          <Retry message={error} onRetry={reload} />
        ) : (
          <CardsSkeleton bare />
        )
      ) : (
        <>
          <div className="grid grid-cols-2 gap-px border border-line bg-line lg:grid-cols-4">
            {DASHBOARD_METRICS.map((id) => (
              <MetricCard key={id} id={id} board={data} currency={currency} range={range} href={`/metrics/${id}${q ? `?${q}` : ""}`} />
            ))}
          </div>
          <section className="border border-line bg-panel" aria-labelledby="mrr-chart">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line px-6 py-4">
              <h2 id="mrr-chart" className="text-[16px] leading-[22px] font-semibold">
                <Link href={`/metrics/mrr${q ? `?${q}` : ""}`} className="rounded-xs hover:text-brand">
                  MRR
                </Link>
              </h2>
              <p className="fig num">{rangeText(range)}</p>
              <p className="fig ml-auto">From Stripe{synced ? `, updated ${fmtAgo(synced)}` : ""}</p>
            </div>
            <div className="px-4 py-5 md:px-6">
              <MrrChart
                periods={(data.series.mrr ?? []).map((p) => p.period)}
                mrr={(data.series.mrr ?? []).map((p) => p.value)}
                movements={MOVEMENTS.map((m) => ({
                  key: m.kind,
                  label: m.label,
                  good: m.good,
                  // Contraction and churn come back as positive amounts lost; they draw below zero.
                  values: (data.series[m.id] ?? []).map((p) => (p.value == null ? null : m.good ? p.value : -p.value)),
                }))}
                net={(data.series.net_new_mrr ?? []).map((p) => p.value)}
                interval={interval}
                format={money}
                label={mrrSummary(data, currency, range)}
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function mrrSummary(b: Board, currency: string, range: Range) {
  const m = metricOf("mrr")!;
  const s = b.summary.mrr;
  const v = plotValue(m, s?.value, currency);
  const p = plotValue(m, s?.previous, currency);
  return `MRR ${rangeText(range)}: ${fmtPlotted(m, v, currency)}, ${fmtDelta(m, v, p, currency)} vs. ${compareLabel(range)}, with new, expansion, reactivation, contraction and churn per period.`;
}

function MetricCard({ id, board, currency, range, href }: { id: MetricId; board: Board; currency: string; range: Range; href: string }) {
  const m = metricOf(id)!;
  const s = board.summary[id];
  const value = plotValue(m, s?.value, currency);
  const previous = plotValue(m, s?.previous, currency);
  const tone = changeTone(m, value, previous);
  const text = fmtPlotted(m, value, currency);
  const change = fmtDelta(m, value, previous, currency);
  const series = board.series[id] ?? [];
  return (
    <Link href={href} className="group flex min-w-0 flex-col bg-panel px-4 pt-4 pb-3 transition-colors md:px-6 md:pt-5 md:pb-4 duration-[var(--dur-hover)] hover:bg-paper focus-visible:relative">
      <p className="eyebrow wrap-break-word">{m.label}</p>
      <p className="mt-2 font-serif text-[24px] leading-7 font-medium wrap-break-word text-ink tabular-nums md:text-[28px] md:leading-8">{text}</p>
      <p className={`mt-1 text-[12px] leading-4 wrap-break-word tabular-nums ${tone === "green" ? "text-success" : tone === "red" ? "text-danger" : "text-muted"}`}>
        {change === "—" ? "—" : `${change} vs. ${compareLabel(range)}`}
      </p>
      <div className="mt-auto pt-3">
        <Sparkline values={series.map((p) => p.value)} label={`${m.label} trend, ${rangeText(range)}`} />
      </div>
    </Link>
  );
}

function CardsSkeleton({ bare = false }: { bare?: boolean }) {
  const body = (
    <div className="space-y-6" role="status" aria-label="Loading">
      <div className="grid grid-cols-2 gap-px border border-line bg-line lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="space-y-3 bg-panel px-6 py-5">
            <span className="bone block h-2.5 w-20" />
            <span className="bone block h-7 w-28" />
            <span className="bone block h-2.5 w-32" />
            <span className="bone block h-8 w-full" />
          </div>
        ))}
      </div>
      <div className="border border-line p-6">
        <span className="bone block h-[400px] w-full" />
      </div>
    </div>
  );
  return bare ? body : <div className={WIDE}>{body}</div>;
}
