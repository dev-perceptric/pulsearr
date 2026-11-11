"use client";

// The Settings page type: a section list on the left, one panel at a time, at most 3xl wide, and one short line under
// each section title. Workspace, Team and Account settings all draw it with these two parts.

export type SettingsNavItem<T extends string> = { value: T; label: string; icon?: React.ReactNode; aside?: React.ReactNode };
export type SettingsNavGroup<T extends string> = { label?: string; items: SettingsNavItem<T>[] };

/**
 * The section list and the one open panel. On phones the list becomes a row above the panel. `inset` is for a
 * dialog: no borders or page padding of its own.
 */
export function SettingsLayout<T extends string>({ label, groups, value, onPick, inset = false, children }: { label: string; groups: SettingsNavGroup<T>[]; value: T | null; onPick: (v: T) => void; inset?: boolean; children: React.ReactNode }) {
  const nav = (
    <nav aria-label={label} className={inset ? "flex shrink-0 gap-1 overflow-x-auto md:w-44 md:flex-col md:gap-0 md:overflow-visible" : "flex shrink-0 gap-1 overflow-x-auto border-b border-line px-4 py-2 md:w-[240px] md:flex-col md:gap-0 md:overflow-y-auto md:border-r md:border-b-0 md:px-3 md:py-6"}>
      {groups.map((g, gi) => (
        <div key={g.label ?? gi} className={`flex shrink-0 gap-1 md:flex-col md:gap-0.5 ${groups.length > 1 ? "md:mb-6" : ""}`}>
          {g.label ? <p className="eyebrow hidden px-3 pb-2 md:block">{g.label}</p> : null}
          {g.items.map((i) => {
            const on = i.value === value;
            return (
              <button
                key={i.value}
                type="button"
                onClick={() => onPick(i.value)}
                aria-current={on ? "page" : undefined}
                className={`flex min-h-9 shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-left text-[14px] transition-colors duration-[var(--dur-hover)] ease-[var(--ease)] [&_svg]:shrink-0 ${on ? "bg-brand-soft font-medium text-brand" : "text-muted hover:bg-hover hover:text-ink"}`}
              >
                {i.icon ? <span className="flex items-center">{i.icon}</span> : null}
                {i.label}
                {i.aside ? <span className="ml-auto hidden text-muted md:flex">{i.aside}</span> : null}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
  if (inset)
    return (
      <div className="flex min-h-0 flex-col gap-4 md:flex-row md:gap-6">
        {nav}
        <div className="min-w-0 flex-1 space-y-8">{children}</div>
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {nav}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-12 px-4 py-8 md:px-10">{children}</div>
      </div>
    </div>
  );
}

/** A section in a settings panel: its title, one short line under it, actions on the right, then its content. */
export function SettingsSection({ title, sub, action, danger = false, children }: { title: React.ReactNode; sub?: string; action?: React.ReactNode; danger?: boolean; children?: React.ReactNode }) {
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className={`flex items-center gap-1.5 text-[16px] leading-[22px] font-semibold wrap-break-word ${danger ? "text-danger" : ""}`}>{title}</h2>
          {sub ? <p className="mt-1 text-[14px] wrap-break-word text-muted">{sub}</p> : null}
        </div>
        {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}
