"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { dialogIn, fadeIn, sheetIn } from "@/lib/motion";
import { X } from "./Icons";
import { IconButton } from "./ui";

// The app's one Modal and one Sheet (docs/brand.md section 12: dialogs 8px corners, max 480px; sheets square, 480px).
// Both close on Escape and the X, keep the keyboard inside while they cover the
// page, and hand focus back to where it was when they close. Only the top one answers Escape, so a modal opened from
// a sheet closes first. A Modal with `submit` runs its footer's primary button on Enter, and on Cmd/Ctrl+Enter from
// anywhere in it; a `locked` one stays open while it works.

const stack: symbol[] = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

type Keys = { submit?: () => void; locked?: boolean };

/** Where a plain Enter belongs to the field, not the dialog: a text area, a button or link, an open list. */
const ownsEnter = (t: HTMLElement | null) =>
  Boolean(t?.closest?.('textarea, button, a[href], select, [contenteditable="true"], [role=listbox], [role=menu]') || t?.getAttribute?.("aria-expanded") === "true" || document.querySelector('[data-floating]:not([role="tooltip"])'));

function useOverlay(box: React.RefObject<HTMLElement | null>, on: boolean, onClose: () => void, trap: boolean, keys: Keys = {}) {
  const close = useRef(onClose);
  const extra = useRef(keys);
  useLayoutEffect(() => {
    close.current = onClose;
    extra.current = keys;
  });
  useEffect(() => {
    if (!on) return;
    const me = Symbol();
    stack.push(me);
    const node = box.current;
    const before = document.activeElement as HTMLElement | null;
    // Children with autoFocus have taken focus by now; otherwise the box takes it, so Tab starts inside.
    if (trap && box.current && !box.current.contains(document.activeElement)) box.current.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== me || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      // A question asked from inside it (askConfirm) answers its own keys.
      if (t && box.current && !box.current.contains(t) && t.closest?.("[role=dialog]")) return;
      if (e.key === "Escape") {
        // An open menu or picker on top closes first.
        if (t?.closest?.("[role=listbox], [role=menu]") || document.querySelector('[data-floating]:not([role="tooltip"])')) return;
        e.preventDefault();
        if (!extra.current.locked) close.current();
      } else if (e.key === "Enter" && extra.current.submit && !e.isComposing && !e.shiftKey && !e.altKey) {
        if (!(e.metaKey || e.ctrlKey) && ownsEnter(t)) return;
        e.preventDefault();
        extra.current.submit();
      } else if (e.key === "Tab" && trap && box.current) {
        const all = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (!all.length) return;
        const first = all[0];
        const last = all[all.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      stack.splice(stack.indexOf(me), 1);
      const now = document.activeElement;
      if (before?.isConnected && (!now || now === document.body || node?.contains(now))) before.focus({ preventScroll: true });
    };
  }, [on, trap, box]);
}

/**
 * A dialog: a title and close in the header, the body, and buttons in the footer when given. With `submit`, Enter runs
 * the footer's primary button (a primary or danger `Button`, the last one) unless focus is in a text area, on a button
 * or in an open list; Cmd/Ctrl+Enter runs it from anywhere. A disabled primary does nothing. With `locked` (while it
 * saves), Escape, the X and a click outside don't close it.
 */
export function Modal({ title, onClose, children, footer, wide = false, submit = false, locked = false }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean; submit?: boolean; locked?: boolean }) {
  const layer = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    void fadeIn(layer.current);
    void dialogIn(card.current);
  }, []);
  // Like a form's Enter, it presses the primary button itself, so the button's own disabled state and handler decide.
  const press = () => {
    const all = foot.current?.querySelectorAll<HTMLButtonElement>('button[data-variant="primary"], button[data-variant="danger"]');
    const primary = all?.[all.length - 1];
    if (primary && !primary.disabled) primary.click();
  };
  useOverlay(card, true, onClose, true, { submit: submit ? press : undefined, locked });
  return (
    <div ref={layer} className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-scrim px-4 pt-[10vh] pb-6" onMouseDown={() => !locked && onClose()}>
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={`w-full rounded-md bg-panel shadow-modal outline-none ${wide ? "max-w-2xl" : "max-w-[480px]"}`}
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line py-3 pr-3 pl-6">
          <h2 className="min-w-0 flex-1 text-[18px] leading-6 font-semibold wrap-anywhere">{title}</h2>
          <IconButton label="Close" align="end" disabled={locked} onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
        <div className="space-y-4 px-6 py-5">{children}</div>
        {footer ? (
          <div ref={foot} className="flex flex-wrap justify-end gap-2 rounded-b-md border-t border-line bg-paper px-6 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A side panel, 480px or 640px (`wide`). On wide screens it sits in the layout, or over the content when `over`; on
 * phones it's a bottom sheet over the page. With a `title` it draws its own header and close button.
 */
export function Sheet({ open, onClose, side = "right", label, title, over = false, wide = false, peek = false, children }: { open: boolean; onClose: () => void; side?: "left" | "right"; label: string; title?: React.ReactNode; over?: boolean; wide?: boolean | "reader"; peek?: boolean; children: React.ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  // It slides in from its edge when it opens (brand motion, 400ms).
  useLayoutEffect(() => {
    if (open) void sheetIn(panel.current, side);
  }, [open, side]);
  // A `peek` sheet floats over a list without dimming it, so another row can be clicked to swap what it shows.
  useOverlay(panel, open, onClose, over && !peek);
  if (!open) return null;
  return (
    <>
      <div className={`fixed inset-0 z-40 bg-scrim ${over && !peek ? "" : "lg:hidden"}`} onMouseDown={onClose} aria-hidden />
      <aside
        ref={panel}
        aria-label={label}
        role={over ? "dialog" : undefined}
        aria-modal={(over && !peek) || undefined}
        tabIndex={-1}
        className={`fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] w-full flex-col border-t border-line bg-panel shadow-modal outline-none md:inset-x-auto md:inset-y-0 md:max-h-none md:max-w-[92vw] md:border-t-0 ${wide === "reader" ? "md:w-[760px]" : wide ? "md:w-[640px]" : "md:w-[480px]"} ${side === "right" ? "md:right-0 md:border-l" : "md:left-0 md:border-r"} ${over ? "" : "lg:static lg:z-auto lg:max-w-none lg:shadow-none"}`}
      >
        {title ? (
          <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-line py-3 pr-3 pl-6">
            <h2 className="min-w-0 flex-1 text-[16px] leading-[22px] font-semibold wrap-anywhere">{title}</h2>
            <IconButton label="Close" align="end" onClick={onClose}>
              <X size={15} />
            </IconButton>
          </div>
        ) : null}
        {children}
      </aside>
    </>
  );
}
