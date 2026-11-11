# Running cost

What PulseARR adds to the monthly bill, from `scripts/cost-model.mjs`. Change `PRICES` or `USAGE` there, run `npm run costs`, and update this page with the new output. Last run: November 11, 2026.

Stages: Beta is 50 teams, Growth is 500 teams. Every number is a monthly total. A price marked "check" couldn't be confirmed on the vendor's own page.

## Usage behind the numbers

Per team per month: 30 morning briefs, 40 Ask questions, 4 alert reasons, 4 cancel summaries, 20 matching checks, 4 forecast notes, 400 emails, and 80 texts for the half of teams that turn SMS on. PostHog: 500 events a team in M0, 4,000 once the metric screens ship. Backups: about 1 GB on B2 at Beta and 20 GB at Growth.

## M0 Foundation

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Server: the shared KVM 2 at Beta (already paid), its own KVM 4 at Growth | $0 | $12.99 (check) |
| Backups on Backblaze B2 | $0.01 (check) | $0.12 (check) |
| Resend (inside the plan the other apps already use) | $0 (check) | $0 (check) |
| PostHog (inside the free 1M events) | $0 (check) | $0 (check) |
| Claude (nothing calls it in M0) | $0 | $0 |
| Domain pulsearr.com ($20 a year) | $1.67 (check) | $1.67 (check) |
| **M0 total** | **$1.67, about $3 with each line rounded up** | **$14.78, about $16 with each line rounded up** |

`docs/m0-plan.md` section 6 and the M0 row of `docs/build-plan.md` use the rounded-up figures ($3 and $16).

## What each milestone adds

| Milestone | Beta | Growth | Note |
|---|---|---|---|
| M0 Foundation | $1.67 | $14.78 | Shared VPS at Beta. The KVM 4 at Growth is the move to PulseARR's own server. |
| M1 Stripe metrics core | $0 | $60.00 | PostHog beyond the free events ($50, check) and a paid currency rates plan ($10, check). |
| M2 Customers and segments | $0 | $0 | Same server. |
| M3 Reports and alerts | $20.00 | $180.00 | PulseARR's own Resend plan: Pro at Beta (20,000 emails); Scale plus 100,000 extra at Growth (200,000 emails). Check. |
| M4 Pulse AI analyst | $63.90 | $639.05 | Briefs on Haiku ($0.0019 each), Ask on Sonnet ($0.0304 a question), alert reasons on Haiku. |
| M5 Recover | $16.60 | $166.00 | Twilio SMS at $0.0083 a text, before carrier fees (check). |
| M6 Cancel flow | $4.80 | $48.00 | Weekly cancel summaries on Sonnet. |
| M7 Revenue by source | $0.45 | $4.50 | Unsure matches checked on Haiku. |
| M8 More billing sources | $0 | $0 | Same server. |
| M9 Forecast and Benchmarks | $6.00 | $60.00 | Forecast notes on Sonnet. |

## Total with every milestone shipped

| | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Exact | $113.43 | $1,172.33 |
| Each line rounded up (as in `docs/build-plan.md` section 7) | about $117 | about $1,175 |

At Growth, revenue is about $30,500 a month (an average of $61 a team) against $1,172 in running cost. Stripe's fees on PulseARR's own plans add about $1,035 (check).

## Open points
- The M1 and M3 rows of the milestones table in `docs/build-plan.md` still say $0 / $0 and $20 / $90. The model puts PostHog and currency rates in M1 ($0 / $60) and Resend at Growth at $180, because 200,000 emails a month is past the Scale plan's 100,000.
- The Growth server is one KVM 4 (`docs/m0-plan.md`). Check its memory again before Growth, once M1's backfills and M4's Ask run on it.
