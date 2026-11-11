"use client";

// The Record page type: who or what the record is, what's next, its tabs with addresses and the open tab in the main
// column, and a 320px right rail of fields. At most 6xl wide.

/** Who or what a record is: its picture, serif name, state tag and one line under it, or a quiet line of facts. */
export function RecordHead({ visual, title, tag, sub, facts, children }: { visual?: React.ReactNode; title: string; tag?: React.ReactNode; sub?: React.ReactNode; facts?: React.ReactNode[]; children?: React.ReactNode }) {
  const shown = (facts ?? []).filter(Boolean);
  return (
    <div className="flex flex-wrap items-start gap-4 px-6 pt-6 pb-4">
      {visual}
      <div className="min-w-0 flex-1">
        <div className="flex min-h-[30px] flex-wrap items-center gap-2">
          <h2 className="font-serif text-[24px] leading-[30px] font-medium wrap-anywhere">{title}</h2>
          {tag}
        </div>
        {sub ? <p className="mt-1 text-[14px] wrap-anywhere text-muted">{sub}</p> : null}
        {shown.length ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted [&_svg]:size-4 [&_svg]:shrink-0">
            {shown.map((f, i) => (
              <span key={i} className="inline-flex min-w-0 items-center gap-1.5 wrap-anywhere">
                {f}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {children ? <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** A square tile with the record's icon, for records without a logo or face. */
export function RecordIcon({ children }: { children: React.ReactNode }) {
  return <span className="flex size-11 shrink-0 items-center justify-center border border-line bg-paper text-muted [&_svg]:size-5">{children}</span>;
}

/** The main column (head, what's next, tabs, the open tab) and the right rail of fields. */
export function RecordLayout({ head, top, tabs, rail, children }: { head?: React.ReactNode; top?: React.ReactNode; tabs?: React.ReactNode; rail?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col bg-panel lg:flex-row">
      <section className="min-w-0 flex-1">
        {head}
        {top}
        {tabs ? <div className="border-b border-line px-6">{tabs}</div> : null}
        {children}
      </section>
      {rail ? <aside className="w-full shrink-0 border-t border-line pb-4 lg:w-[320px] lg:border-t-0 lg:border-l">{rail}</aside> : null}
    </div>
  );
}
