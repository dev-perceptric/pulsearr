"use client";

import type { IconName } from "lucide-react/dynamic";
import { lazy, Suspense } from "react";

// Icons stored by name: any of Lucide's line icons ("building-2"), loaded one by one so the catalog never holds up the
// first screen. Drawn at the brand's 1.5px stroke. No emoji (docs/brand.md section 8): any other name draws the fallback.

/** A stored icon is a Lucide name: lowercase words and dashes. */
export const isLucide = (name: string | null | undefined): name is IconName => Boolean(name && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name));

/** Lucide's icon by name, downloaded on first use. Unknown names draw nothing. */
export const LucideIcon = lazy(() => import("lucide-react/dynamic").then((m) => ({ default: m.DynamicIcon })));

/** An icon by its stored name, or the fallback when there's none. */
export function AppIcon({ name, size = 16, fallback = null, className = "", stroke = 1.5 }: { name?: string | null; size?: number; fallback?: React.ReactNode; className?: string; stroke?: number }) {
  if (!isLucide(name)) return <>{fallback}</>;
  const room = <span style={{ width: size, height: size }} className="inline-block shrink-0" />;
  return (
    <Suspense fallback={room}>
      <LucideIcon name={name} size={size} strokeWidth={stroke} strokeLinecap="square" className={`shrink-0 ${className}`} aria-hidden fallback={() => room} />
    </Suspense>
  );
}
