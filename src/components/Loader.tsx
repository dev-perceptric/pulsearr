"use client";

// The four-square loader and the burst for big moments. Loading a screen uses the skeleton `Loading` (ui.tsx); the
// loader is for work in progress inside a button or a line ("Syncing Stripe").

/** Four squares blinking in turn. Takes the text color; `size` is one square. */
export function Loader({ size = 6, className = "text-brand" }: { size?: number; className?: string }) {
  return (
    <span className={`loader ${className}`} style={{ "--l": `${size}px` } as React.CSSProperties} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

/** Big moments only (something launched): small squares in the brand's blues burst out from a point. */
export function burst(x: number, y: number) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["var(--pulse-blue)", "var(--sky)", "var(--ice)", "var(--navy-deep)"];
  for (let i = 0; i < 30; i++) {
    const p = document.createElement("i");
    const s = 4 + Math.random() * 4;
    p.className = "burst-bit";
    p.style.cssText = `left:${x}px;top:${y}px;width:${s}px;height:${s}px;background:${colors[i % colors.length]}`;
    document.body.appendChild(p);
    const a = Math.random() * Math.PI * 2;
    const v = 50 + Math.random() * 110;
    const dx = Math.cos(a) * v;
    const dy = Math.sin(a) * v - 50;
    p.animate(
      [
        { transform: "translate(-50%, -50%) rotate(0deg)", opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${Math.random() * 360}deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${dx * 1.15}px), calc(-50% + ${dy + 90}px)) rotate(${Math.random() * 540}deg)`, opacity: 0 },
      ],
      { duration: 900 + Math.random() * 300, easing: "cubic-bezier(0.65, 0.05, 0, 1)" },
    ).onfinish = () => p.remove();
  }
}

/** Burst from the middle of an element, like the button that was just pressed. */
export function burstFrom(el: Element | null) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2);
}
