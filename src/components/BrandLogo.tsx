"use client";

import { useState } from "react";
import { GoogleIcon } from "./Icons";
import { HoverTip } from "./Floating";

// Logos for the tools PulseARR connects to. Shown in place of their names wherever a logo can stand alone, with the
// name as the tooltip and screen-reader label. Marks we draw ourselves are inline SVG; the rest load the tool's own
// icon and fall back to its first letter.

export type Brand = "stripe" | "google" | "slack" | "hubspot" | "paddle" | "claritia";

export const BRAND: Record<Brand, { name: string; domain?: string }> = {
  stripe: { name: "Stripe", domain: "stripe.com" },
  google: { name: "Google" },
  slack: { name: "Slack", domain: "slack.com" },
  hubspot: { name: "HubSpot", domain: "hubspot.com" },
  paddle: { name: "Paddle", domain: "paddle.com" },
  claritia: { name: "Claritia" },
};

/** The brand from a name someone typed, like "Stripe account". */
export function brandOf(text: string | null | undefined): Brand | null {
  const t = (text ?? "").toLowerCase();
  return (Object.keys(BRAND) as Brand[]).find((b) => t.includes(b)) ?? null;
}

/** A brand's logo in a square tile. Falls back to the first letter when the logo can't load. */
export function BrandLogo({ brand, size = 20 }: { brand: Brand; size?: number }) {
  const [failed, setFailed] = useState(false);
  const b = BRAND[brand];
  const box = { width: size, height: size };
  if (brand === "google")
    return (
      <span role="img" aria-label={b.name} className="inline-flex shrink-0">
        <GoogleIcon size={size} />
      </span>
    );
  if (brand === "claritia")
    return (
      <svg role="img" aria-label={b.name} width={size} height={size} viewBox="0 0 32 32" className="shrink-0">
        <rect width="32" height="32" rx="8" fill="#266df0" />
        <path d="M7 12V7h5M20 7h5v5M25 20v5h-5M12 25H7v-5" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M11.5 16.5l3 3 6-7" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (!b.domain || failed)
    return (
      <span role="img" aria-label={b.name} className="inline-flex shrink-0 items-center justify-center rounded-xs border border-line bg-paper font-medium text-ink" style={{ ...box, fontSize: Math.max(9, size * 0.45) }}>
        {b.name[0]}
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(b.domain)}&sz=128`} alt={b.name} width={size} height={size} className="shrink-0 rounded-xs" style={box} onError={() => setFailed(true)} />
  );
}

/** Pick one tool by its logo. The name shows on hover. */
export function BrandPicker<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; brand: Brand }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={BRAND[o.brand].name}
            onClick={() => onChange(o.value)}
            className={`relative inline-flex size-12 items-center justify-center rounded-md border bg-panel transition-colors duration-[var(--dur-hover)] ease-[var(--ease)] ${on ? "border-brand bg-brand-soft" : "border-line hover:bg-hover"}`}
          >
            <BrandLogo brand={o.brand} size={24} />
            <HoverTip text={BRAND[o.brand].name} />
          </button>
        );
      })}
    </div>
  );
}
