"use client";

import { useEffect, useSyncExternalStore } from "react";
import { plainError } from "@/lib/plainError";
import { tell } from "./Dialogs";

// Undo after delete (docs/brand.md section 12, Notices: one short line at the bottom left with an action): the rows hide at once and the delete runs 10 seconds later, unless Undo is pressed.
// Lists filter out `useHidden()` ids; <UndoHost /> (mounted once) shows the toast. `notify` uses the same spot for a
// short line with one action, like "2 not saved, Retry", in place of a dialog.

type Pending = { key: number; label: string; ids: string[]; commit: () => Promise<unknown>; after?: () => void; timer: ReturnType<typeof setTimeout> };

const WAIT = 10_000;
let pending: Pending[] = [];
let hidden: ReadonlySet<string> = new Set();
let next = 1;
const listeners = new Set<() => void>();
const emit = () => {
  hidden = new Set(pending.flatMap((p) => p.ids));
  for (const l of listeners) l();
};

async function run(p: Pending) {
  clearTimeout(p.timer);
  try {
    await p.commit();
  } catch (e) {
    void tell("Couldn't delete", plainError(e));
  }
  pending = pending.filter((x) => x.key !== p.key);
  emit();
  p.after?.();
}

/** Hide these ids now and delete them in 10 seconds. `after` runs once the delete is done (a reload). */
export function deleteLater(label: string, ids: string[], commit: () => Promise<unknown>, after?: () => void) {
  const key = next++;
  const p: Pending = { key, label, ids, commit, after, timer: setTimeout(() => void run(p), WAIT) };
  pending = [...pending, p];
  emit();
}

/** Bring back the last delete. */
export function undoLast() {
  const p = pending.at(-1);
  if (!p) return;
  clearTimeout(p.timer);
  pending = pending.slice(0, -1);
  emit();
}

type Notice = { key: number; label: string; action?: { label: string; run: () => void } };
let notice: Notice | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/** One short line at the bottom of the screen for 8 seconds, with an optional action. */
export function notify(text: string, action?: { label: string; run: () => void }) {
  // A technical message never shows as it is: one plain line instead.
  const label = plainError(text, action ? "Couldn't finish that. Try again." : "Something went wrong. Try again.");
  if (noticeTimer) clearTimeout(noticeTimer);
  const key = next++;
  notice = { key, label, action };
  noticeTimer = setTimeout(() => {
    if (notice?.key === key) notice = null;
    emit();
  }, 8_000);
  emit();
}

function closeNotice() {
  if (noticeTimer) clearTimeout(noticeTimer);
  notice = null;
  emit();
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const EMPTY: ReadonlySet<string> = new Set();

/** Ids waiting to be deleted, to leave out of lists. */
export const useHidden = () => useSyncExternalStore(subscribe, () => hidden, () => EMPTY);

export function UndoHost() {
  useSyncExternalStore(subscribe, () => hidden, () => EMPTY);
  const last = pending.at(-1);
  useEffect(() => {
    // Leaving the page runs every waiting delete now.
    const flush = () => pending.forEach((p) => void run(p));
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);
  useEffect(() => {
    if (!last) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !(e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable=true]"))) {
        e.preventDefault();
        undoLast();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [last]);
  const shown = last ? { label: last.label, action: { label: "Undo", run: undoLast } } : notice;
  if (!shown) return null;
  return (
    <div role="status" className="on-dark rise fixed bottom-5 left-5 z-[95] flex max-w-[calc(100vw-40px)] items-center gap-4 rounded-md bg-navy-deep py-2 pr-2 pl-4 text-[14px] text-white shadow-pop">
      <span className="min-w-0 wrap-break-word">{shown.label}</span>
      {shown.action ? (
        <button
          type="button"
          onClick={() => {
            const run = shown.action!.run;
            if (!last) closeNotice();
            run();
          }}
          className="min-h-7 shrink-0 rounded-md px-2.5 text-[14px] font-medium text-sky transition-colors duration-[var(--dur-hover)] ease-[var(--ease)] hover:bg-slate"
        >
          {shown.action.label}
        </button>
      ) : null}
    </div>
  );
}
