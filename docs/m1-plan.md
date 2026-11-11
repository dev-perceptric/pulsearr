# M1: Stripe metrics core

Written November 11, 2026. M1 connects a team's Stripe, loads its history, keeps it current, turns it into exact MRR movements, and shows the dashboard, one page per metric and the live feed. It builds on M0 (sign-in, workspaces, jobs queue, worker, brand shell).

---

## 1. Connect

**Main path: a Stripe App with read-only permissions.** Stripe only gives read-only access to apps built on Stripe Apps. Regular Connect OAuth asks for `read_write`, and Stripe advises new platforms against it. The app is made under the Stripe account the other apps already use.

- `stripe-app/stripe-app.json`: app id `com.pulsearr.analytics`, OAuth install, read permissions only: `customer_read`, `subscription_read`, `invoice_read`, `charge_read`, `refund_read`, `plan_read`, `product_read`, `coupon_read`, `credit_note_read`, `event_read`, `balance_transaction_read`, `account_read` (exact names: check against Stripe's permissions reference before upload).
- Button "Connect Stripe" opens Stripe's install page with a `state` value tied to the workspace and person (sealed, 10-minute life).
- `/api/stripe/callback` checks `state`, trades the code for tokens at `https://api.stripe.com/v1/oauth/token` with the platform key, and stores `stripe_user_id`, the access token and the refresh token sealed (`src/lib/seal.ts`). Access tokens are refreshed before they run out.
- Server values: `STRIPE_SECRET_KEY` (the platform's key), `STRIPE_APP_CLIENT_ID`, `STRIPE_CONNECT_WEBHOOK_SECRET`. They go into hPanel for `pulsearr-web` and `pulsearr-worker` and show in `/api/health/setup`.

**Backup path: a restricted key**, under Settings → Sources only, for beta teams while Stripe reviews the app. A read-only restricted key (`rk_live_…`) is checked with one call to `/v1/account`, then sealed. The key must not be able to write: the check refuses a key that can create a webhook endpoint.

**Disconnect** removes the tokens and, after `askConfirm`, every row from that source.

## 2. Keeping it current

- **Webhooks:** one endpoint, `/api/stripe/webhook`, set in Stripe as a Connect webhook ("events on connected accounts"). It checks the signature, stores the event once in `stripe_events` (unique on the event id) and answers 200 within the time limit. It never trusts the event's copy of the object.
- **Each event starts a job** `stripe.sync_object` keyed by object id. The job fetches the object fresh from Stripe, so two copies of an event, or events in the wrong order, end in the same state.
- **Event poll:** every 5 minutes per source, `stripe.poll_events` reads `/v1/events` after the last seen event. Restricted-key sources have no webhooks, so this is how they stay current. For app sources it fills any webhook that was missed. Stripe keeps events 30 days.
- **Backfill** (`stripe.backfill`, one job per object type, each page a checkpoint): prices, products, coupons, customers, subscriptions, invoices with lines, charges, refunds, credit notes. The last 12 months of invoices load first so the first numbers show in about a minute; older history follows.
- **Nightly check** (`stripe.check`): today's MRR per customer from our tables against MRR worked out from Stripe's live subscriptions. A customer off by more than $1 is rebuilt and logged.
- Every Stripe call goes through `src/lib/retry.ts`. 429 and 5xx wait and retry, and a lost lease picks up at the last checkpoint.

## 3. The MRR engine

One pure function per customer, in `src/lib/mrr/`, run in Node by the tests and the worker:

`buildCustomer(input) → { segments, movements }`

- **Input:** the customer's subscriptions, their items and prices, invoice lines, discounts, trial dates, pauses, cancel and end dates, unpaid invoices, and daily currency rates.
- **Segments:** for each subscription, the MRR between two dates. History comes from invoice lines (the recurring line, never proration lines). The time after the last invoice comes from the subscription as it is now.
- **Rules** (from `docs/build-plan.md` 3.2, tested in every build):
  - Annual counts 1/12 a month, quarterly 1/3, every N months 1/N, weekly 52/12, daily 365/12.
  - Discounts lower MRR. A 100% discount, a trial and one-time fees count 0.
  - Quantity multiplies, tiers are worked out per tier, and metered prices count from the last invoice.
  - A paused subscription counts 0 until it resumes.
  - Unpaid for more than 30 days after the due date is churn on day 31. Paying later is reactivation.
  - Amounts in other currencies use that day's rate (`fx_rates`), and the rate is stored with the movement.
  - Money is whole cents (integers). Rounding happens once, per movement, half away from zero.
- **Movements:** the customer's total MRR changes on a date. From 0 for the first time is `new`, from 0 after churn is `reactivation`, to 0 is `churn`, up is `expansion`, down is `contraction`. Each one stores the Stripe object or event behind it.
- **Rebuild, not patch:** any change to a customer rebuilds that customer's movements from scratch (`mrr.rebuild_customer`, keyed by customer, so a burst of events runs once). The same input always gives the same rows, so repeats and wrong order can't drift.
- **Daily totals:** `mrr_daily` is rebuilt from the earliest changed day forward: MRR, ARR, the five movement sums, active customers, and new, churned and reactivated customer counts.

## 4. Database (`008_stripe.sql`, `009_mrr.sql`)

| Table | Holds |
|---|---|
| `sources` | One per connected Stripe: workspace, kind (`stripe_app` or `stripe_key`), account id and name, sealed tokens, status, backfill progress per object type, last event id, last error |
| `stripe_events` | Every event once: id (unique per source), type, created, object id, received at, processed at |
| `stripe_customers`, `stripe_prices`, `stripe_products`, `stripe_coupons`, `stripe_subscriptions`, `stripe_subscription_items`, `stripe_invoices`, `stripe_invoice_lines`, `stripe_charges`, `stripe_refunds` | Clean copies: workspace, source, Stripe id (unique per source), the fields the engine needs, and the raw object as `jsonb` |
| `fx_rates` | Daily rates (base, quote, day, rate), loaded nightly from the European Central Bank's free daily file |
| `mrr_movements` | Workspace, customer, day, kind, amount in cents in the workspace currency, original amount and currency, rate, the Stripe object behind it |
| `mrr_customer_days` | Each customer's MRR from one date to the next (the segments, for the customer list and the check) |
| `mrr_daily` | Each day's totals per workspace |
| `feed_items` | The live feed: signup, upgrade, downgrade, cancel, reactivation, failed payment, refund |

Row level security on every table: members read their workspace's rows, and only the worker (service role) writes. The leak tests in `tests/db` cover each table. Deleting a source deletes its rows through `on delete cascade`.

Reads for the screens are SQL functions: `metric_series(ws, metric, from, to, interval)`, `metric_summary(ws, from, to)` (current value, last period, change), `metric_movements(ws, metric, from, to)` (the customers behind a change) and `feed(ws, before, limit)`.

## 5. Screens

- **Dashboard** (`/dashboard`): before Stripe is connected, `ToolIntro` with "Connect Stripe". During the first import, the progress line. After it, the key numbers (MRR, ARR, net new MRR, active customers, customer churn, revenue churn, ARPU, LTV), each with its change from last period and a small trend line, and the MRR chart with its five movement bars.
- **Metric page** (`/metrics/[metric]`): one chart, date range, compare to the last period, daily, weekly or monthly, and the table of customers behind the change.
- **Live feed** (`/feed`): every signup, upgrade, downgrade, cancel, reactivation, failed payment and refund, newest first, updating every 15 seconds.
- **Settings → Sources:** connect, status, import progress, last sync, disconnect.
- **Metrics in M1:** MRR, ARR, net new MRR, new, expansion, reactivation, contraction, churned MRR, active customers, new customers, ARPU, customer churn rate, revenue churn rate, NRR, GRR, LTV, quick ratio. Trials, cash and cohorts come in M2.
- All numbers go through `src/lib/format.ts`. Charts are square, navy lines, `--pulse-blue` for the current value only.

## 6. Tests

- **Fixtures** (`tests/fixtures/stripe/*.json`), each with the answer worked out by hand in the file: monthly to annual mid-month with proration, 50% coupon for 3 months, 100% coupon then paid, trial to paid, trial to cancel, unpaid 31 days then paid, refund after cancel, two subscriptions on one customer, seat quantity change, pause and resume, euro customer on a dollar workspace, cancel at period end, and a tiered price.
- If any fixture is off by one cent, the build fails.
- **Flaky cases run 50 times each** with the events shuffled and repeated: the movements must match exactly.
- **Webhook route:** bad signature refused, the same event twice stored once, an unknown account ignored.
- **Jobs:** a lost lease in the middle of a backfill picks up at the checkpoint without duplicate rows. A 429 from Stripe waits and retries.
- **Database:** leak tests for every new table, and `mrr_daily` rebuilt from movements matches a hand total.

## 7. Order of work

1. Migrations, the engine and the fixture tests.
2. The Stripe client, connect (app and key), webhook route, sync, poll, backfill and nightly check jobs.
3. The read functions and the screens.
4. Deploy, then the Stripe App upload and a real test account.

## 8. Running cost

M1 adds work to the servers M0 already runs and calls no paid service.

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Server (same VPS at Beta, the Growth server from M0) | $0 | $0 |
| Stripe API and Stripe Apps | $0 | $0 |
| Currency rates (European Central Bank daily file) | $0 | $0 |
| Database growth (about 50 MB a team, inside the backups already counted) | $0 | $0 (check) |
| Claude (nothing calls it in M1) | $0 | $0 |
| **M1 adds** | **$0 a month** | **$0 a month** |
| **Running total with M0** | **about $3 a month** | **about $16 a month** |

## 9. Not in M1
- Customer pages, segments, cohorts, goals, CSV export, trials and cash metrics (M2).
- Emails and Slack alerts (M3). Pulse (M4).
