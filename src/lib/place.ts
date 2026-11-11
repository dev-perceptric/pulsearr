// Where a floating menu, picker or tooltip goes on screen, next to the thing that opened it. Pure, so tests cover
// the flips and the edges. Used by src/components/Floating.tsx.

export type Placement = "bottom-start" | "bottom-end" | "bottom" | "top-start" | "top-end" | "top" | "right-start" | "left-start";

const EDGE = 8;

export type Spot = { left: number; top: number; maxHeight?: number; minWidth?: number };

/** Where a box of `size` goes next to `a`, kept on screen. Pure, so it can be tested. */
export function place(a: { left: number; top: number; right: number; bottom: number; width: number; height: number }, size: { width: number; height: number }, placement: Placement, gap: number, screen: { width: number; height: number }): Spot {
  const clampX = (x: number) => Math.max(EDGE, Math.min(x, screen.width - size.width - EDGE));
  const clampY = (y: number) => Math.max(EDGE, Math.min(y, screen.height - size.height - EDGE));
  if (placement === "right-start" || placement === "left-start") {
    const right = a.right + gap;
    const left = a.left - gap - size.width;
    const fitsRight = right + size.width <= screen.width - EDGE;
    const fitsLeft = left >= EDGE;
    const x = placement === "right-start" ? (fitsRight || !fitsLeft ? right : left) : fitsLeft || !fitsRight ? left : right;
    return { left: clampX(x), top: clampY(a.top), maxHeight: screen.height - 2 * EDGE };
  }
  const below = screen.height - a.bottom - gap - EDGE;
  const above = a.top - gap - EDGE;
  const wantsTop = placement.startsWith("top");
  // Above when asked and it fits (or fits better there); below otherwise, unless it only fits better above.
  const top = wantsTop ? size.height <= above || above >= below : size.height > below && above > below;
  const room = Math.max(80, top ? above : below);
  const height = Math.min(size.height, room);
  const y = top ? a.top - gap - height : a.bottom + gap;
  const x = placement.endsWith("-end") ? a.right - size.width : placement.endsWith("-start") ? a.left : a.left + a.width / 2 - size.width / 2;
  return { left: clampX(x), top: Math.max(EDGE, y), maxHeight: room };
}

