"use client";

import type { DrawingKind } from "./Drawing";
import { Empty } from "./ui";

// The first screen of a tool, before there's anything to show (docs/brand.md section 12, Empty states): one drawing in
// the middle, a short title ("Connect Stripe to see your MRR"), one line under it and the one button.

export function ToolIntro({ drawing = "pulse", title, lead, action }: { drawing?: DrawingKind; title: string; lead?: string; action?: React.ReactNode }) {
  return (
    <Empty drawing={drawing} title={title} action={action}>
      {lead}
    </Empty>
  );
}
