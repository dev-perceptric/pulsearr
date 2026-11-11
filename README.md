# PulseARR

Your MRR, explained, with the money you're losing won back on its own.

Subscription analytics for SaaS: MRR, churn, LTV and cohorts from Stripe, an AI analyst that says what moved and why, failed payment recovery, a cancel flow, and revenue tied back to the deals, campaigns and AI search answers that brought it in.

The plan: [`docs/build-plan.md`](docs/build-plan.md). The milestone being built: [`docs/m0-plan.md`](docs/m0-plan.md). Running cost: [`docs/costs.md`](docs/costs.md).

## Run locally

Needs Node 22.6 or later.

```bash
npm install
cp .env.example .env.local
```

Point the app at a database, either:

- a local Supabase: `npx supabase start` (after `npx supabase init` once, if there's no `supabase/config.toml`), then put its API URL and keys in `.env.local` (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`) and its Postgres URL in `DATABASE_URL`, and run the files in `supabase/migrations` in order with `psql`; or
- a development stack you already have, with its URL and keys.

Set `SECRETS_KEY` (`openssl rand -base64 32`). Without `RESEND_API_KEY`, emails are logged instead of sent.

```bash
npm run dev      # the app at http://localhost:3000
npm run worker   # the job worker, in a second terminal
```

Next.js reads `.env.local` on its own; the worker doesn't, so export the variables first or run `node --env-file=.env.local --experimental-strip-types worker/main.ts`.

## Checks

```bash
npm run lint
npm run typecheck   # the app and the worker
npm test            # unit tests and the UI rule tests
npm run test:db     # database leak tests: needs Postgres (DATABASE_URL_TEST, or the local one)
npm run costs       # the running cost model
```

`.github/workflows/checks.yml` runs all of these except `costs` on every push and pull request.

## Deploy

Everything runs on the Hostinger VPS. A push to `main` runs Checks; when they pass, `.github/workflows/build-images.yml` builds `pulsearr-web` and `pulsearr-worker` and the server picks them up within 5 minutes. Migrations in `supabase/migrations` run on their own from `main`. The compose files and the server runbook are in [`deploy/README.md`](deploy/README.md).

## Website

`site/index.html` is the marketing site: one self-contained page (fonts from Google Fonts, no build step). Open it in a browser or serve the `site/` folder from any static host.

Brand: [`docs/brand.md`](docs/brand.md) and [`docs/brand-tokens.css`](docs/brand-tokens.css).
