"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { popIn } from "@/lib/motion";
import { place, type Placement, type Spot } from "@/lib/place";

export type { Placement } from "@/lib/place";

// The one layer every menu, picker, popover and tooltip opens in. It's drawn above the whole page (a portal on
// <body>, fixed to the screen), so a table, a card, a scrolling panel or a side sheet can never cut it off. It sits
// next to the thing that opened it, flips above or to the other side when there isn't room, stays on screen, and
// follows along when the page scrolls or resizes. Never draw a menu with `absolute top-full` inside a box again.


type Props = {
  /** What it opens from. */
  anchor: React.RefObject<HTMLElement | null>;
  placement?: Placement;
  gap?: number;
  /** Called on a click outside it and its anchor, or on Escape. Leave it out for tooltips. */
  onClose?: () => void;
  /** At least as wide as the anchor; a number also sets a least width in pixels. */
  matchWidth?: boolean | number;
  /** Tooltips: never takes clicks. */
  passive?: boolean;
  className?: string;
  style?: React.CSSProperties;
  role?: React.AriaRole;
  "aria-label"?: string;
  innerRef?: React.RefObject<HTMLDivElement | null>;
  onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
  /** Placed again whenever this changes: for an anchor that moves without resizing (a chart's hover point). */
  track?: unknown;
  children: React.ReactNode;
};

export function Floating({ anchor, placement = "bottom-start", gap = 4, onClose, matchWidth, passive, className = "", style, role, innerRef, onMouseLeave, track, children, ...aria }: Props) {
  const own = useRef<HTMLDivElement>(null);
  const box = innerRef ?? own;
  const [spot, setSpot] = useState<Spot | null>(null);
  // The first time it's placed, it fades in and rises 4px from the side it opened on (docs/brand.md, Motion).
  const shown = spot !== null;
  useEffect(() => {
    if (!shown) return;
    const a = anchor.current?.getBoundingClientRect();
    const b = box.current?.getBoundingClientRect();
    const from = placement.endsWith("-start") && (placement === "right-start" || placement === "left-start") ? "side" : a && b && b.top < a.top ? "above" : "below";
    void popIn(box.current, from);
    // Only on first showing; later moves (scroll, resize) don't animate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useLayoutEffect(() => {
    const el = box.current;
    const at = anchor.current;
    if (!el || !at) return;
    const update = () => {
      const a = at.getBoundingClientRect();
      // Measured at its natural size, before any height limit.
      const least = matchWidth ? Math.min(Math.max(a.width, typeof matchWidth === "number" ? matchWidth : 0), window.innerWidth - 16) : 0;
      const size = { width: Math.max(el.scrollWidth, least), height: el.scrollHeight };
      const next = place(a, size, placement, gap, { width: window.innerWidth, height: window.innerHeight });
      if (matchWidth) next.minWidth = least;
      setSpot((s) => (s && s.left === next.left && s.top === next.top && s.maxHeight === next.maxHeight && s.minWidth === next.minWidth ? s : next));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    ro.observe(at);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor, box, placement, gap, matchWidth, track]);

  // Layers opened later sit on top; a click in one of them (a Select inside a popover) isn't a click outside.
  const [depth] = useState(nextDepth);

  useEffect(() => {
    if (passive) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      const layer = t.closest?.("[data-floating]") as HTMLElement | null;
      if (layer && Number(layer.dataset.floating) > depth) return;
      close.current?.();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !close.current) return;
      e.preventDefault();
      close.current();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [anchor, box, passive, depth]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={box}
      data-floating={depth}
      role={role}
      {...aria}
      onMouseLeave={onMouseLeave}
      style={{
        position: "fixed",
        left: spot?.left ?? 0,
        top: spot?.top ?? 0,
        maxHeight: spot?.maxHeight,
        minWidth: spot?.minWidth,
        visibility: spot ? undefined : "hidden",
        overflowY: spot?.maxHeight ? "auto" : undefined,
        pointerEvents: passive ? "none" : undefined,
        ...style,
      }}
      className={`${passive ? "z-[110]" : "z-[100]"} ${className}`}
    >
      {children}
    </div>,
    document.body,
  );
}
let opened = 0;
/** A number above every layer open so far. Any portal layer (Select's list too) marks itself with it. */
export const nextDepth = () => ++opened;

/** Hover and keyboard-focus state for a tooltip; spread `handlers` on the element. Touch shows nothing; a press hides it. */
export function useTip(delay = 300) {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const handlers = {
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType === "touch") return;
      clear();
      timer.current = setTimeout(() => setOn(true), delay);
    },
    onPointerLeave: () => (clear(), setOn(false)),
    onPointerDown: () => (clear(), setOn(false)),
    onFocus: (e: React.FocusEvent) => e.currentTarget.matches(":focus-visible") && setOn(true),
    onBlur: () => (clear(), setOn(false)),
  };
  return { on, handlers };
}

/** A tooltip: ink, white 12px text, 8px corners, above everything. */
export function Tip({ anchor, text, placement = "bottom", wrap = false, className }: { anchor: React.RefObject<HTMLElement | null>; text: React.ReactNode; placement?: Placement; wrap?: boolean; className?: string }) {
  return (
    <Floating anchor={anchor} placement={placement} gap={6} passive role="tooltip" className={className ?? `rounded-md bg-ink px-2 py-1 text-[12px] leading-4 font-normal text-white shadow-pop ${wrap ? "w-64 whitespace-normal" : "max-w-[min(20rem,calc(100vw-16px))] wrap-break-word"}`}>
      {text}
    </Floating>
  );
}

/**
 * For a popup that opens from the box it's written in: put `<span ref={mark} hidden />` inside that box and pass
 * `anchor`. The box (usually the trigger's wrapper) is the anchor, so clicking the trigger again doesn't count as outside.
 */
export function useParentAnchor() {
  const mark = useRef<HTMLSpanElement>(null);
  const anchor = useMemo(
    () =>
      ({
        get current() {
          return mark.current?.parentElement ?? null;
        },
      }) as React.RefObject<HTMLElement | null>,
    [],
  );
  return { mark, anchor };
}

/** A tooltip for the element it's written in: drop it inside any button or row. */
export function HoverTip({ text, placement = "bottom", wrap, delay = 300, className }: { text: React.ReactNode; placement?: Placement; wrap?: boolean; delay?: number; className?: string }) {
  const { mark, anchor } = useParentAnchor();
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = mark.current?.parentElement;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const enter = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      clearTimeout(t);
      t = setTimeout(() => setOn(true), delay);
    };
    const leave = () => (clearTimeout(t), setOn(false));
    const focus = () => el.matches(":focus-visible") && setOn(true);
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerdown", leave);
    el.addEventListener("focus", focus);
    el.addEventListener("blur", leave);
    return () => {
      clearTimeout(t);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", leave);
      el.removeEventListener("focus", focus);
      el.removeEventListener("blur", leave);
    };
  }, [mark, delay]);
  return (
    <>
      <span ref={mark} hidden />
      {on ? <Tip anchor={anchor} text={text} placement={placement} wrap={wrap} className={className} /> : null}
    </>
  );
}

/** A popup that opens from the box it's written in (a `relative` wrapper around its trigger). */
export function FloatingHere(props: Omit<Props, "anchor">) {
  const { mark, anchor } = useParentAnchor();
  return (
    <>
      <span ref={mark} hidden />
      <Floating anchor={anchor} {...props} />
    </>
  );
}

/** Draws its children on <body>, above every box: for popups that place themselves with `position: fixed`. */
export function OnTop({ children }: { children: React.ReactNode }) {
  return typeof document === "undefined" ? null : createPortal(children, document.body);
}
