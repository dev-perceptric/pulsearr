"use client";

import { ToolIntro } from "@/components/ToolIntro";
import { Button, Page } from "@/components/ui";

// M0's dashboard: the first screen of the Stripe tool. M1 turns the button on and draws the numbers.
export function DashboardScreen() {
  return (
    <Page title="Dashboard">
      <ToolIntro
        drawing="revenue"
        title="Connect Stripe to see your MRR"
        lead="Read-only access. First numbers in about 60 seconds."
        action={
          <Button type="button" disabled aria-disabled="true">
            Connect Stripe
          </Button>
        }
      />
    </Page>
  );
}
