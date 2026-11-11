# M0: Foundation

Written November 11, 2026, after reading Omniscient, Claritia and Arrowsterr and the VPS they run on. M0 builds everything PulseARR needs before it reads a single Stripe event: sign-in, workspaces, the jobs queue, the database, deploys, tests and the app shell in the brand. M1 (Stripe metrics) starts on top of it.

---

## 1. What we learned from the other three apps

| # | What happened | What PulseARR does instead |
|---|---|---|
| 1 | All three apps moved Render → Fly → Hostinger VPS in about four weeks. Claritia is still half on Fly and Render. Old Render text is still in Omniscient's errors. | Start on the VPS on day one, with the same pattern the other apps ended on. No Render or Fly files, no mentions. |
| 2 | Migrations were run by hand. Omniscient's code has about 44 "before migration N" fallbacks. Arrowsterr had a `create table if not exists` that hid an old table and skipped the new one, plus two files numbered 056. | Migrations run on their own from `main` (one transaction per file, recorded in `ops.schema_migrations`). A test fails on duplicate or skipped numbers. No code fallbacks for unrun migrations. |
| 3 | The jobs queue was rebuilt three times. Omniscient's first version had a fixed 10-minute lock and a global dedupe key cleared by hand. | Copy Claritia's newest design from day one: one waiting job per key, a lease with heartbeats, retry schedule kept in the database, cleanup by tick. |
| 4 | Workers were shrunk to 512 MB and grown back to 1 GB twice (Arrowsterr, Claritia). | Size each container once, from what it actually runs. PulseARR's worker has no browser or LibreOffice, so 512 MB is enough and stays. |
| 5 | Every page load made four reads in a row until Omniscient added one `boot()` call. | `boot()` from the first commit: one call returns the workspace, every workspace the person is in, and their role. |
| 6 | A wrong server key showed as "Workspace not found" (Claritia). | Server errors keep their real cause in logs and in `/api/health/setup`, and people see one plain line. |
| 7 | Fly's dashboard broke the line breaks in a pasted key. The encryption key can't change without asking every customer to reconnect. | One `SECRETS_KEY` set on day one, never rotated without a re-seal script. Keys are sealed with a `v1:` prefix so a later version can be added. |
| 8 | Render's install skipped dev packages, so the build failed on worker type imports (Claritia). | The worker lives in `worker/` with its own `tsconfig`. The web build never sees it. |
| 9 | Omniscient's and Arrowsterr's workers poll the web app over HTTP, so the web app can't rest and a slow page slows the jobs. | The PulseARR worker claims jobs straight from the database and runs them itself. |
| 10 | Retry helpers were copied into five places in Omniscient, and the Resend email call into four. | One `src/lib/retry.ts` and one `src/lib/email.ts`. A test fails on a second copy of the Resend address. |
| 11 | Sample data went in, was narrowed, then removed (Omniscient 044 → 080). | New workspaces start empty, from day one. |
| 12 | Omniscient has no CI checks, and the leak tests only run by hand. | `checks.yml` runs lint, typecheck, unit tests, the UI rule tests and the database leak tests on every push. |
| 13 | Arrowsterr's production branch is named after a Claude session. | Production is `main`. Images and migrations come only from `main`. |
| 14 | The planned AI step cache was never built in Claritia. | `ai_cache` table and one `askClaude()` wrapper in M0, so M4 (Pulse) starts with it. |
| 15 | The two rule sets disagree (Omniscient pills, Claritia square). | PulseARR follows `docs/brand.md` only: square cards, 8px buttons, navy and blue. The guard tests enforce it. |

---

## 2. Where each piece comes from

| Piece | Copied from | Changes |
|---|---|---|
| UI kit (`ui.tsx`, `Select`, `Dialogs`, `Overlay`, `Floating`, `Undo`, `ToolIntro`, `Loader`, `SettingsLayout`, `RecordLayout`, `PageBoundary`) | Omniscient | Re-skinned to the PulseARR brand. CRM parts removed (stages, lifecycle, Otto, Google/Microsoft connect, CRM routes). |
| Small libraries (`motion`, `place`, `format`, `plainError`, `streamed`, `autosave`, `signin`, `cronAuth`) | Omniscient | `format.ts` gains money, percent and MRR change formats. |
| Sign-in screen and session (`AuthScreen`, `supa.ts`, `serverAuth.ts`) | Omniscient | Copy, logo, terms link and home route. |
| Workspaces, members, invites, roles, `boot()` | Omniscient (schema, 006, 086, 115) | Pulled out of the CRM tables into clean migrations. Roles: owner, admin, member. |
| Jobs queue (`020_foundation.sql` jobs part, `jobs.ts`) | Claritia | Runs over supabase-js on the web side and over `pg` in the worker. Adds Arrowsterr's "wait without using an attempt". |
| Sealing secrets (`seal.ts`) | Claritia | As is. |
| Database leak tests (`supabase_stub.sql`, `test-db.sh`, `leaks.sql`) | Omniscient | New tests for PulseARR's tables. |
| UI guard tests (`ui-rules`, `floating`) | Omniscient | Plus three new rules: no pill buttons, no rounded cards, no old token names. |
| Dockerfiles, `build-images.yml`, `checks.yml` | Arrowsterr | Branch `main`, image names `pulsearr-web` and `pulsearr-worker`, a Postgres service in CI for the leak tests. |
| VPS stack (`sb-pulsearr`, Caddy entry, Traefik labels, migrate runner, autodeploy entry) | The live VPS setup | Copied as compose files in `deploy/`, with no secrets in the repo. |
| Cost model (`scripts/cost-model.mjs`, `npm run costs`) | Omniscient | PulseARR's own usage and prices. |

---

## 3. What M0 builds

### 3.1 Sign-in
- Email link with a 6-digit code (no passwords, so no password resets to build or support), plus Google.
- `/signin` and `/signup` addresses with a safe `?next=` return.
- Sessions in the browser (PKCE, auto-refresh). Server routes check the bearer token and membership with a 30-second cache.
- Sign-in emails sent by GoTrue through Resend's SMTP, using PulseARR's templates.

### 3.2 Workspaces and team
- First sign-in creates a workspace named after the email's company domain. The person is its owner.
- Invite by email. The invitee joins by signing in with that email. One invite email sent through Resend.
- Roles: owner, admin, member. Owners and admins invite, remove and change roles. Only the owner deletes the workspace.
- Workspace settings: name, members, invites, delete workspace (with `askConfirm`).
- `boot(p_pref)` returns everything the shell needs in one call. The shell draws from the last saved boot right away, then refreshes.
- Row level security on every table: members read their workspace's rows, writes go through checked functions.

### 3.3 Jobs queue and worker
- `jobs` table: `workspace_id`, `kind`, `key`, `payload`, status (queued, running, done, failed), `run_after`, `attempts`, `max_attempts`, lease fields, `last_error`.
- Only one queued job per `(workspace, kind, key)`: enqueuing again updates the waiting job. Two jobs with the same key never run at once.
- The worker leases a job, renews the lease every third of its length, and stops the job if the lease is lost.
- Retries: 1 min, 5 min, 30 min, 2 h, 6 h. A job can say "don't retry" or "retry after N seconds", or "wait" without using an attempt (Stripe rate limits in M1).
- Cleanup: done jobs kept 7 days, failed ones 30.
- The worker (`worker/`) claims jobs straight from Postgres, runs them, and runs a tick each minute for scheduled work. M0 ships one job kind, `email.invite`, and one tick, `jobs.prune`.

### 3.4 Database and migrations
- `supabase/migrations/001_*.sql` onward, applied by the runner on the VPS from `main`.
- Rules for every file: runs inside a transaction, safe to run twice, works with the code already live.
- `ops.schema_migrations` records each file. A test fails on a gap or duplicate in the numbers.
- `npm run test:db` builds a throwaway database from a stub of Supabase's auth schema plus every migration, then runs the leak tests.

### 3.5 Waitlist
- `waitlist` table and `POST /api/waitlist` (email, source, saved once per email, rate limited per IP).
- The pulsearr.com form posts to it. The success line on the site changes to "You're on the list."

### 3.6 App shell and screens
- Navy sidebar (logo, Dashboard, Settings, workspace switcher, account menu), white work area.
- **Dashboard:** the tool intro for M1 ("Connect Stripe to see your MRR"), with the button turned off until M1.
- **Settings:** Workspace, Team, Account.
- `/api/health` (is the app up), `/api/health/setup` (is each setting present, for us), `/api/version` (build, so open tabs know to reload).
- Error boundary per page with a short line and "Reload".

### 3.7 Shared services
- `src/lib/retry.ts`: retries with growing waits for timeouts, busy, network, 5xx and 429, used by every save, send and AI call.
- `src/lib/email.ts`: `sendEmail()` through Resend, quiet when the key is missing in development.
- `src/lib/ai.ts`: `askClaude()` with the `ai_cache` step cache and per-workspace daily limits (`ai_usage`). Nothing calls it in M0.
- `src/lib/seal.ts`: AES-256-GCM sealing for tokens (Stripe tokens from M1).
- PostHog through `/ingest`, `track()` for events.

### 3.8 Tests and checks
- Unit tests with `node --test` (TypeScript run directly).
- UI rule tests: no raw colors, no browser pop-ups, no cut-off text, popups on the floating layer, dates and numbers through `format.ts`, named icon buttons, no pill buttons, no rounded cards.
- Database tests: a member of one workspace can't read or change another's rows; an invited email joins the right workspace; `boot()` returns the right data.
- Jobs tests: one waiting job per key, lease loss, retry schedule, prune.
- CI runs all of it on every push.

---

## 4. On the VPS

The server (Hostinger KVM 2: 2 CPUs, 8 GB) already runs five apps. Over the last 24 hours it used 4.5–5.4 GB of memory and about 30% CPU.

| Container | Memory limit | From |
|---|---|---|
| `sb-pulsearr` db (Postgres 17) | 512 MB | Same image as the other stacks |
| `sb-pulsearr` auth (GoTrue) | 128 MB | Same |
| `sb-pulsearr` rest (PostgREST) | 128 MB | Same |
| `sb-pulsearr` api-gw (Envoy) | 128 MB | Same |
| `sb-public` pulsearr entry (Caddy) | 64 MB | Added to the shared file |
| `pulsearr-web` | 512 MB | `ghcr.io/dev-perceptric/pulsearr-web` |
| `pulsearr-worker` | 512 MB | `ghcr.io/dev-perceptric/pulsearr-worker` |
| `pulsearr-migrate` | 128 MB | Same as Arrowsterr's runner |

Storage is left out until a feature needs files (it would add 256 MB). Real use is about 1 GB, so the server peaks near 6.4 GB of 8 GB. Before Growth, PulseARR moves to its own VPS (section 6).

**Addresses**
- `app.pulsearr.com` → `pulsearr-web` (Traefik, Let's Encrypt)
- `db.pulsearr.com` → `sb-pulsearr` gateway (through `sb-public`)
- `pulsearr.com` and `www` stay on Hostinger web hosting (the marketing site)

**Backups:** a nightly `pg_dump` of the PulseARR database kept 14 days on the server, copied to Backblaze B2 for 90 days.

**Uptime:** add `app.pulsearr.com/api/health` to the existing Gatus checker.

---

## 5. Order of work

| Step | What | Done when |
|---|---|---|
| 1 | Next.js app, configs, brand tokens, fonts | `npm run build` passes |
| 2 | UI kit copied and re-skinned, guard tests | `npm test` passes |
| 3 | Migrations: workspaces, team, boot, jobs, ai cache, waitlist, ops | `npm run test:db` passes with leak tests |
| 4 | Libraries: retry, email, seal, ai, format additions, server auth, jobs | Unit tests pass |
| 5 | Sign-in, onboarding, shell, dashboard intro, settings | Works against a local Supabase |
| 6 | Worker, Dockerfiles, CI, `deploy/` compose files | Images build in GitHub Actions |
| 7 | VPS: create `sb-pulsearr`, runner, web, worker, DNS for `app` and `db` | `app.pulsearr.com/api/health` is up |
| 8 | Waitlist form on pulsearr.com points at the app | A test signup lands in the table |

Steps 1–6 happen in the repo. Step 7 changes the shared production server and needs a yes before it starts. Step 8 follows step 7.

---

## 6. Running cost

M0 runs on the VPS already paid for, so most of it costs nothing new.

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Server: shared KVM 2 at Beta; own KVM 4 at Growth | $0 (already paid) | $13 (check) |
| Backups on Backblaze B2 (about 1 GB at Beta, 20 GB at Growth) | $1 (check) | $1 (check) |
| Resend (sign-in, invites; inside the plan already used by the other apps) | $0 (check) | $0 (check) |
| PostHog (inside the free 1M events) | $0 | $0 (check) |
| Claude (nothing calls it in M0) | $0 | $0 |
| Domain pulsearr.com (Namecheap, about $20 a year at renewal) | $2 (check) | $2 (check) |
| **M0 total** | **about $3 a month** | **about $16 a month** |

This replaces the M0 line in `docs/build-plan.md` ($17 at Beta, $122 at Growth), which assumed a new server for PulseARR alone.

---

## 7. Not in M0
- Billing for PulseARR itself (Launch milestone).
- File storage.
- Anything that reads Stripe (M1).
