"use client";

import { useRef, useState } from "react";
import { localDay } from "@/lib/chart";
import { fmtDate, fmtParts } from "@/lib/format";
import { monthGrid, PRESETS, shiftMonth, type Preset, type Range } from "@/lib/ranges";
import { Floating } from "./Floating";
import { CalendarDays, ChevronLeft, ChevronRight } from "./Icons";
import { Select } from "./Select";
import { Button, IconButton } from "./ui";

// The date range control on the dashboard and metric pages: the app's own Select for the presets, and for Custom a
// calendar on the floating layer (first click the start, second the end; days after today can't be picked).

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Nov 1 – Nov 10, 2026", or "Dec 20, 2025 – Jan 5, 2026" across a year. */
export function rangeText(r: { from: string; to: string }) {
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
  return `${fmtDate(localDay(r.from), { year: !sameYear })} – ${fmtDate(localDay(r.to))}`;
}

export function RangePicker({ range, now, onChange }: { range: Range; now: string; onChange: (p: Preset, custom?: { from: string; to: string }) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  return (
    <div ref={box} className="flex flex-wrap items-center gap-2">
      <Select
        ariaLabel="Date range"
        value={range.preset}
        options={PRESETS}
        onChange={(p) => (p === "custom" ? setOpen(true) : onChange(p))}
        className="h-9 min-w-40 rounded-md border border-line bg-panel px-3 text-[14px] text-ink transition-colors duration-[var(--dur-hover)] hover:bg-hover"
      />
      {range.preset === "custom" ? (
        <Button variant="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Custom range ${rangeText(range)}`}>
          <CalendarDays size={16} />
          <span className="num">{rangeText(range)}</span>
        </Button>
      ) : null}
      {open ? (
        <Floating anchor={box} placement="bottom-end" onClose={() => setOpen(false)} role="dialog" aria-label="Pick dates" className="rounded-md border border-line bg-panel p-3 shadow-pop">
          <Calendar
            initial={range}
            now={now}
            onDone={(r) => {
              setOpen(false);
              onChange("custom", r);
            }}
            onCancel={() => setOpen(false)}
          />
        </Floating>
      ) : null}
    </div>
  );
}

function Calendar({ initial, now, onDone, onCancel }: { initial: { from: string; to: string }; now: string; onDone: (r: { from: string; to: string }) => void; onCancel: () => void }) {
  const [month, setMonth] = useState(initial.to.slice(0, 7));
  const [from, setFrom] = useState<string>(initial.from);
  const [to, setTo] = useState<string | null>(initial.to);
  const [y, m] = month.split("-").map(Number);
  const weeks = monthGrid(y!, m!);
  const pick = (d: string) => {
    if (to != null || d < from) {
      setFrom(d);
      setTo(null);
    } else setTo(d);
  };
  return (
    <div className="w-[260px]">
      <div className="mb-2 flex items-center gap-1">
        <IconButton label="Previous month" onClick={() => setMonth((x) => shiftMonth(x, -1))}>
          <ChevronLeft size={16} />
        </IconButton>
        <p className="min-w-0 flex-1 text-center text-[14px] font-medium" aria-live="polite">
          {fmtParts(localDay(`${month}-01`), { month: "long", year: "numeric" })}
        </p>
        <IconButton label="Next month" disabled={month >= now.slice(0, 7)} onClick={() => setMonth((x) => shiftMonth(x, 1))}>
          <ChevronRight size={16} />
        </IconButton>
      </div>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {WEEKDAYS.map((w) => (
              <th key={w} className="h-7 text-center text-[11px] font-medium text-muted">
                {w.slice(0, 2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((wk, i) => (
            <tr key={i}>
              {wk.map((d, j) => {
                if (!d) return <td key={j} />;
                const end = d === from || d === to;
                const inside = to != null && d > from && d < to;
                const later = d > now;
                return (
                  <td key={j} className="p-0">
                    <button
                      type="button"
                      disabled={later}
                      onClick={() => pick(d)}
                      aria-pressed={end || inside}
                      aria-label={fmtDate(localDay(d))}
                      className={`flex size-[36px] items-center justify-center rounded-md tabular-nums transition-colors duration-[var(--dur-hover)] disabled:pointer-events-none disabled:text-line-strong ${end ? "bg-brand text-white" : inside ? "bg-brand-soft text-brand" : "text-ink hover:bg-hover"} ${d === now && !end ? "font-semibold" : ""}`}
                    >
                      {Number(d.slice(8))}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        <p className="num mr-auto text-[12px] text-muted">{to ? rangeText({ from, to }) : fmtDate(localDay(from))}</p>
        <Button variant="secondary" small onClick={onCancel}>
          Cancel
        </Button>
        <Button small disabled={!to} onClick={() => to && onDone({ from, to })}>
          Apply
        </Button>
      </div>
    </div>
  );
}
