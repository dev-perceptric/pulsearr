# PulseARR build plan

PulseARR shows a subscription business its real revenue numbers, explains why they moved, and wins back money that's slipping away. It does what Baremetrics does, for less money, with an AI analyst on top and the link to sales and marketing that Baremetrics doesn't have.

Written November 10, 2026. Baremetrics facts come from its own site on that date. Any price that couldn't be confirmed on the vendor's own page is marked "check".

---

## 1. What Baremetrics sells today

### Plans (priced by ARR band)
| Plan | Price | ARR band | Integrations | Adds |
|---|---|---|---|---|
| Launch | $75/mo (FAQ says from $49) | $0–360K | 1 | 28+ metrics, trial insights, email reports, auto segments, Clearbit data, chat support |
| Growth | $255/mo (FAQ says from $189) | $360K–3.6M | 2 | Custom dashboards, unlimited segments, benchmarks, exports, goals, Slack, Intercom |
| Scale | $1,152/mo (FAQ says from $749) | $3.6M+ | Unlimited | Scenario planning, budgets and expenses, Analytics API, dedicated rep |

- 35% off for paying yearly. 14-day free trial with no card.
- Their integrations page says "free until you reach $180K ARR," which clashes with the pricing page. Their pricing is confusing, and that's an opening for us.

### Add-ons
| Add-on | Price | What it does |
|---|---|---|
| Recover | +$129/mo | Failed payment emails (7 by default), SMS, in-app banners, paywall after a grace period, hosted card-update form, card-expiry reminders at 30 and 7 days. "Recover more than your Baremetrics cost or next month is free." |
| Cancellation Insights | +$129/mo | Cancel survey in the app or by email, retention offers per reason as a Stripe coupon, follow-up emails by reason |
| Forecasting (Forecast+) | Contact sales | P&L, balance sheet, cash flow, scenarios A/B/C, hiring plans, budget vs. actual, QuickBooks and Xero |

A Launch customer who wants Recover and Cancellation Insights pays **$333 a month**.

### Other pieces
- **Control Center:** a live feed of every signup, payment, upgrade, downgrade and cancel.
- **Benchmarks:** compare your numbers to similar companies.
- **Augmentation:** bring in outside data by CSV, Zapier or API (rep activity, support tickets, NPS).
- **People Insights:** one page per customer with every payment and change.
- **Slack alerts** and daily, weekly and monthly email reports.
- **Analytics API** and an **MCP server** for Claude, Cursor and Codex.

### Integrations
Stripe, Braintree, Chargebee, Recurly, Paddle (beta), Rebill (beta), Apple App Store, Google Play, Shopify Partners, QuickBooks, Xero, HubSpot, Intercom, Slack, plus a CSV or API connector for anything else.

### How they grow
- **Open Startups:** public revenue dashboards companies share on purpose. Each one is a backlink and an ad.
- **Open Benchmarks:** free industry numbers that get cited and linked.
- Comparison pages against ProfitWell, ChartMogul, Churn Buster, Stripe Analytics and others.
- Academy glossary pages for every metric (MRR, churn, LTV), free calculators, an affiliate program and a live demo with sample data.

### Their weak spots
- Expensive once you add Recover and Cancellation Insights.
- Pricing pages that contradict each other.
- No answer to "who brought this revenue in": no tie to deals, reps, campaigns or AI search.
- Insights are charts. The founder still has to work out what happened.

---

## 2. What PulseARR is

**One line:** Your MRR, explained, with the money you're losing won back on its own.

**For:** SaaS founders and small finance or growth teams from $0 to $5M ARR, on Stripe first.

### How we win
1. **Cheaper and simpler.** Free up to $10K MRR. Recover and the cancel flow are in the paid plans, with no $129 add-ons.
2. **The AI analyst (Pulse).** Every morning: what moved, why, and what to do. Ask anything in plain English: "Why did churn jump in March?" Every answer links to the customers and payments behind it.
3. **Revenue to source.** Connect Omniscient, HubSpot or Claritia and see MRR by rep, deal source, campaign and landing page. Connect Arrowsterr and see revenue from visitors who came from ChatGPT, Perplexity and Google AI answers. Baremetrics can't do this.
4. **Numbers you can trust.** Every number can be traced back to the Stripe events behind it, and a test suite of hard billing cases runs on every change.
5. **Open by default.** Free public revenue pages (`pulsearr.com/open/yourcompany`) to copy the Open Startups growth loop.

---

## 3. Product, piece by piece

### 3.1 Connect
- "Connect Stripe" button, one click through Stripe's own sign-in (Stripe Connect, read-only). No pasted API keys in the main flow.
- Backfill all history on the jobs queue: customers, subscriptions, invoices, charges, refunds, coupons and plans. Show progress, and show the first numbers as soon as the last 12 months are in.
- Live updates from Stripe webhooks after that, plus a nightly check that compares our totals to Stripe's and repairs any gaps.

### 3.2 Metrics (match Baremetrics' 28+, then add)
| Group | Metrics |
|---|---|
| Revenue | MRR, ARR, Net New MRR, New, Expansion, Reactivation, Contraction, Churned MRR, ARPU, ARPA |
| Customers | Active customers, new customers, upgrades, downgrades, reactivations, cancellations |
| Churn | Customer churn rate, revenue churn rate, net revenue retention (NRR), gross revenue retention (GRR) |
| Value | LTV, average subscription length, quick ratio |
| Trials | Active trials, trial conversion rate, time to convert |
| Cash | Gross volume, net revenue, fees, refunds, failed charges, other revenue (one-time) |
| Cohorts | Retention by signup month, by plan, by country, by source |

**The MRR rules (written down once, tested forever):**
- Annual plans count as 1/12 a month. Quarterly as 1/3. Weekly as 52/12 = 4.33 weeks a month.
- Coupons lower MRR. 100%-off coupons, free trials and one-time fees count as zero.
- A customer more than 30 days past due counts as churned. If they pay later, it's a reactivation.
- Every currency is turned into the team's chosen currency at that day's rate, and the rate used is stored.
- Each change becomes one row in `mrr_movements` (new, expansion, contraction, churn, reactivation) with the Stripe event that caused it. Every chart is a sum over those rows.

### 3.3 Screens
- **Dashboard:** the key numbers with trend lines, plus Pulse's summary of the day at the top.
- **Metric page:** one chart, date range, compare to the last period, split by segment, and the list of customers behind the change.
- **Live feed (like Control Center):** every signup, upgrade, downgrade, cancel and failed payment as it happens.
- **Customers:** a list with filters, and one page per customer with the full history, MRR over time and notes.
- **Segments:** filter by plan, country, billing period, coupon, Stripe metadata, or any field from a connected CRM. Save and share them.
- **Cohorts:** retention heat map by month.
- **Goals:** set an MRR or churn target and track it.
- **Reports:** daily, weekly and monthly emails, plus Slack alerts for big moves.

### 3.4 Pulse, the AI analyst
- **Morning brief:** 3–5 lines on what moved yesterday and why, sent by email and Slack and shown on the dashboard.
- **Ask:** questions in plain English answered from the team's own data. Pulse writes SQL against a read-only view of that one team's data, runs it and answers with the numbers and links to the rows.
- **Alerts with reasons:** "Churn MRR is 2.3x the 90-day average. 4 of 6 cancels were on the Starter plan and listed price as the reason."
- **Rules:** every number Pulse says comes from a query result, never from the model's memory. Answers to the same question on the same data replay from the step cache and never call the model again.
- **MCP server:** the same tools for Claude, Cursor and Codex, like Baremetrics MCP.

### 3.5 Recover (failed payments)
- Works with Stripe's own Smart Retries. We never retry charges ourselves.
- Email sequence (7 by default, editable), optional SMS, in-app banner and paywall after a grace period, using a small script snippet.
- Hosted card-update page on `pay.pulsearr.com` or the team's own domain, in their brand, writing the new card back to Stripe.
- Card-expiry reminders at 30 and 7 days, and reminders before yearly renewals.
- Report: money at risk, money recovered, recovery rate (recovered ÷ attempts) and which email won it back.
- Promise: "Recover more than your PulseARR plan costs or next month is free."

### 3.6 Cancel flow
- Cancel survey in the app (script snippet) or by email one hour after the cancel.
- A retention offer per reason, applied as a Stripe coupon or a pause.
- Follow-up emails by reason, with timing the team picks.
- Report: reasons over time, saves, MRR saved, and Pulse's summary of written answers.

### 3.7 Revenue by source (our moat)
- **CRM:** Omniscient and HubSpot. Match Stripe customers to CRM companies by email domain and Stripe metadata. Show MRR by rep, deal source and industry.
- **Marketing:** Claritia, plus UTM tags saved at signup through a small script. Show MRR by campaign, channel and first page.
- **AI search:** Arrowsterr. Show signups and MRR from ChatGPT, Perplexity, Gemini and Google AI answers next to what those AIs say about the brand.
- All matches show how sure we are. A match we're unsure about is shown as unsure, never guessed.

### 3.8 Later
- **Forecast:** MRR forecast from current growth and churn, with scenarios A/B/C and a hiring plan. QuickBooks and Xero for cash. (Baremetrics charges extra and hides the price.)
- **Benchmarks:** compare to similar PulseARR teams who opt in, grouped by ARPU and size. Publish the yearly summary as free "Open Benchmarks."
- **Open pages:** public revenue pages a team can turn on, with a "Powered by PulseARR" link.

### 3.9 Integrations, in order
1. Stripe (launch)
2. Paddle, Lemon Squeezy and Chargebee
3. Apple App Store and Google Play
4. Braintree and Recurly
5. CSV and API import for anything else
6. Slack, Omniscient, HubSpot, Claritia and Arrowsterr for data out and data in

---

## 4. Pricing

| Plan | Price | MRR covered | What's in it |
|---|---|---|---|
| Free | $0 | Up to $10K MRR | All metrics, dashboard, live feed, customers, weekly email, 1 billing source |
| Starter | $29/mo | Up to $50K MRR | Everything in Free, plus Pulse briefs and Ask (100 questions a month), segments, cohorts, Slack, daily email, Recover, cancel flow |
| Growth | $79/mo | Up to $250K MRR | Everything in Starter, plus revenue by source, unlimited sources, goals, MCP and API, 500 questions a month |
| Scale | $199/mo | Over $250K MRR | Everything in Growth, plus forecast, benchmarks, SSO, priority support, 2,000 questions a month |

- 20% off yearly. 14-day trial of Growth, no card.
- Compared with Baremetrics Launch plus both add-ons ($333), Starter is $29 and Growth is $79.
- Bands use MRR because founders think in MRR. They're checked each month, with a 60-day grace period before an upgrade is asked for.

**Revenue math at Growth (500 paying teams):** a mix of 60% Starter, 30% Growth and 10% Scale averages about $61 a team, which is about **$30,400 a month**.

---

## 5. How it's built

### Stack (same as Omniscient and Claritia)
- **App:** Next.js 16, React 19, Tailwind 4, TypeScript.
- **Database:** Postgres on the Hostinger VPS. Plain SQL migrations in `supabase/migrations`, run in order with `psql`.
- **Sign-in:** the same Supabase-style auth the other apps use.
- **Worker:** a Node worker on the VPS claiming jobs from a Postgres jobs queue (backfills, webhook processing, nightly checks, emails, AI briefs).
- **AI:** Claude through `@anthropic-ai/sdk`. Haiku for briefs and summaries, Sonnet for Ask. Every call goes through the step cache.
- **Email:** Resend. **SMS:** Twilio, only once the team turns it on.
- **Brand:** the shared brand system (Inter at 13px, the green accent, no browser pop-ups or dropdowns, no hidden text).

### Data model (first pass)
| Table | Holds |
|---|---|
| `workspaces`, `members` | Teams and who's in them |
| `sources` | Each connected billing tool, its tokens (encrypted) and sync state |
| `stripe_events` | Every raw webhook and backfill event, stored once by its ID |
| `customers`, `subscriptions`, `subscription_items`, `invoices`, `charges`, `plans`, `coupons` | Clean copies of billing data, with the source and its ID |
| `mrr_movements` | One row per MRR change: date, customer, type, amount, currency, rate, source event |
| `daily_metrics` | Each day's totals per workspace and segment, rebuilt from movements |
| `fx_rates` | Daily currency rates |
| `segments`, `goals`, `reports`, `alerts` | Saved views and notices |
| `recover_cases`, `recover_messages` | Each failed payment and every email or SMS about it |
| `cancel_responses`, `offers` | Cancel answers and offers |
| `source_links` | Matches to CRM, marketing and Arrowsterr records, with how sure the match is |
| `ai_cache` | Step cache for every model call |
| `jobs` | The queue |

Row level security on every table keeps each team to its own data, and Pulse's queries run as a read-only role that can only see that team's views.

### The metrics engine
1. **Ingest:** each Stripe event is stored once (`stripe_events`, unique on its ID), so a repeated webhook does nothing.
2. **Apply:** the worker updates the clean tables in event order per customer.
3. **Move:** each subscription change writes `mrr_movements` rows from the rules in 3.2.
4. **Roll up:** `daily_metrics` is rebuilt for the affected days only.
5. **Check:** each night, MRR from our tables is compared with MRR rebuilt from Stripe's live subscriptions. Any gap over $1 rebuilds that customer and is logged.

### Tests that must pass before every release
A fixture set of fake Stripe histories, each with the right answer written down by hand:
- Monthly to annual switch mid-month, with proration
- 50% coupon for 3 months, then full price
- 100%-off coupon, then a paid plan
- Trial to paid, and trial to cancel
- Failed payment, 31 days past due, then paid (churn, then reactivation)
- Refund after a cancel
- Two subscriptions on one customer
- Quantity change on a per-seat plan
- Pause and resume
- Euro customer on a dollar account
- Webhooks arriving out of order and twice

If any fixture's MRR is off by one cent, the build fails. Flaky cases (out-of-order and repeated webhooks) run 50 times each.

### Security
- Stripe access is read-only. Recover's card page uses Stripe's own hosted fields, so card numbers never touch our servers.
- Tokens are encrypted in the database. Every team's data is fenced off by row level security.
- A team can delete its data and disconnect a source at any time, and both actually remove the rows.

---

## 6. Milestones

Each milestone states what it adds to the monthly bill. Full totals are in section 7.

| # | Milestone | Ships | Time | Adds per month (Beta / Growth) |
|---|---|---|---|---|
| M0 | Foundation | Repo, auth, workspaces, jobs queue, brand shell, VPS, backups, waitlist page on pulsearr.com | 1 week | $17 / $122 (servers, backups, domain, analytics, currency rates) |
| M1 | Stripe metrics core | Connect Stripe, backfill, webhooks, MRR engine, the fixture tests, dashboard, metric pages, live feed | 3 weeks | $0 / $0 (same servers) |
| M2 | Customers and segments | Customer pages, segments, cohorts, goals, CSV export | 2 weeks | $0 / $0 |
| M3 | Reports and alerts | Daily, weekly, monthly emails, Slack alerts | 1 week | $20 / $90 (Resend) |
| M4 | Pulse AI analyst | Morning brief, Ask, alerts with reasons, MCP server | 2 weeks | $63 / $630 (Claude) |
| M5 | Recover | Emails, SMS, banner and paywall, card page, expiry reminders, report | 3 weeks | $17 / $166 (Twilio SMS) |
| M6 | Cancel flow | Survey, offers, follow-ups, report | 2 weeks | $3 / $30 (Claude summaries) |
| **Launch** | Public launch | Product Hunt, Open pages, comparison pages | — | — |
| M7 | Revenue by source | Omniscient, HubSpot, Claritia, Arrowsterr, UTM script | 3 weeks | $5 / $50 (Claude matching help) |
| M8 | More billing sources | Paddle, Lemon Squeezy, Chargebee, App Store, Google Play | 4 weeks | $0 / $0 |
| M9 | Forecast and Benchmarks | MRR forecast, scenarios, QuickBooks and Xero, opt-in benchmarks | 4 weeks | $5 / $50 (Claude) |

Launch lands about 14 weeks after starting M0.

---

## 7. Running cost

Assumptions per team per month: 30 morning briefs, 40 Ask questions, 4 alert reasons, 400 emails (reports, Recover, cancel follow-ups) and 80 SMS for teams that turn SMS on (half of teams).

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Hostinger VPS (app, worker, Postgres): KVM 4 at Beta, two KVM 8 at Growth | $13 (check) | $50 (check) |
| Backups (Backblaze B2) | $2 (check) | $10 (check) |
| Domain pulsearr.com | $2 | $2 |
| Resend (Pro at Beta, Scale at Growth) | $20 (check) | $90 (check) |
| Twilio SMS ($0.0083 per US text, 25 teams × 80 at Beta, 250 × 80 at Growth) | $17 (check) | $166 (check) |
| Claude: briefs on Haiku (about $0.002 each, cached) | $3 (check) | $30 (check) |
| Claude: Ask on Sonnet (about $0.03 a question, schema cached) | $60 (check) | $600 (check) |
| Claude: cancel summaries, alert reasons, matching help | $13 (check) | $130 (check) |
| PostHog (product analytics) | $0 | $50 (check) |
| Currency rates API | $0 (free tier, check) | $10 (check) |
| **Total** | **about $130 a month** | **about $1,140 a month** |

**Margin at Growth:** about $30,400 in revenue against $1,140 in running cost, before people and payment fees. Stripe's own fees on our subscriptions are about 2.9% plus $0.30 a charge (check), about $1,030 a month at Growth.

Ask questions are capped per plan (section 4), so a heavy team can't run up the Claude bill.

---

## 8. Go to market

1. **Waitlist now.** pulsearr.com with a "see your real MRR in 60 seconds" promise and a free MRR calculator.
2. **Open pages from day one.** Free public revenue pages for indie founders on X, who share them. Each page links back.
3. **Comparison pages:** PulseARR vs. Baremetrics, ChartMogul, ProfitWell, Stripe dashboard and Churn Buster. Lead with price: "$29 vs. $333."
4. **Metric glossary:** one page per metric (MRR, ARR, churn, NRR, LTV, quick ratio) with a free calculator on each.
5. **Recover calculator:** "Paste your MRR, see how much you lose to failed payments." This is the strongest paid hook.
6. **Product Hunt and Indie Hackers** at launch, then build in public on X with our own Open page.
7. **Affiliates:** 30% recurring for a year.
8. **Cross-sell:** every Omniscient, Claritia and Arrowsterr team with Stripe gets a "see your revenue" link.
9. **Track our own AI search visibility** in Arrowsterr from day one, so "best Baremetrics alternative" answers in ChatGPT name PulseARR.

---

## 9. Risks

| Risk | What we do |
|---|---|
| Wrong numbers lose trust fast | Fixture tests, nightly check against Stripe, every number traceable to its events |
| Stripe's free dashboard gets better | Win on Pulse, Recover and revenue by source, which Stripe doesn't do |
| ProfitWell and ChartMogul have free tiers | Our free tier is just as generous, and paid starts at $29 |
| Claude costs grow with heavy users | Ask caps per plan, step cache, Haiku for anything repeated |
| Stripe webhook outages or delays | Store every event once, nightly repair, alerts when webhooks stop arriving |
| Recover emails land in spam | Send from the team's own domain with SPF, DKIM and DMARC set up during connect |

---

## 10. First two weeks

1. Point pulsearr.com at a waitlist page.
2. Set up the VPS, Postgres, auth and the jobs queue (M0).
3. Register the Stripe Connect app and write the fixture set with hand-checked answers before writing the MRR engine.
4. Build ingest and `mrr_movements` until every fixture passes.
5. Connect our own Stripe accounts (Omniscient, Claritia, Arrowsterr) as the first real test data.
