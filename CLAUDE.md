# PulseARR

Subscription analytics for SaaS: MRR, churn, LTV and cohorts from Stripe, Pulse (an AI analyst that says what moved and why), failed payment recovery (Recover), a cancel flow, and revenue tied back to the deals, campaigns and AI search answers that brought it in. It sits beside Omniscient (CRM), Claritia (marketing) and Arrowsterr (AI search), on the same stack, with its own brand.

Read first: `docs/build-plan.md` (the plan), `docs/m0-plan.md` (the milestone being built and the lessons from the other apps), `docs/brand.md` (look and copy), `docs/costs.md` (running cost), `deploy/README.md` (the server).

Everything runs on the Hostinger VPS: `pulsearr-web` (Next.js in `src/`), `pulsearr-worker` (`worker/`, claims jobs straight from Postgres) and the `sb-pulsearr` Supabase stack. Sign-in and data go through the Supabase-style API at `SUPABASE_URL` (`https://db.pulsearr.com`).

## Rule: every build includes its running cost
- Every build plan, feature or milestone states what it adds to the monthly bill: servers plus every paid service, Claude tokens included, as monthly totals at Beta (50 teams) and Growth (500 teams). No per-team numbers.
- Do the math in `scripts/cost-model.mjs`: add the new job or service to `USAGE` or `PRICES`, run `npm run costs`, and update `docs/costs.md`.
- Mark any price that couldn't be confirmed on the vendor's own page "check" (`check: true` in the model).

## Rule: reliability first
- Numbers must be exact. A wrong number costs more than a missing feature.
- Never ship a change to the MRR engine, Stripe sync, the jobs queue, Recover sending or money formatting without a test that proves it, including a flaky or out-of-order case (repeated and out-of-order webhooks, a lost lease, a retry).

## Rule: AI goes through askClaude()
- Every model call goes through `askClaude()` in `src/lib/ai.ts`: the `ai_cache` step cache and the per-workspace limits (`ai_usage`). The same question on the same data replays from the cache and never calls the model.
- Every number Pulse states comes from a query result, never from the model's memory.

## Rule: no browser pop-ups or browser dropdowns
- Never `<select>`, `window.prompt`, `window.confirm` or `window.alert`. Use `Select` from `src/components/Select.tsx` and `askText`, `askConfirm` or `tell` from `src/components/Dialogs.tsx`.

## Rule: errors retry, then one short line
- Every save, send and AI call retries hiccups (timeout, busy, network, 5xx, 429) with growing waits through `src/lib/retry.ts`; a batch that still fails is split (`splitBatch`) so one bad row never stops the rest.
- What's left shows as one short line with a Retry (`notify` from `src/components/Undo.tsx`), never a dialog of failures or a raw database message. The real cause goes to the logs and `/api/health/setup`.

## Rule: minimal copy
- Working screens hold labels, buttons and real errors only. No help text, cost notes or explanations.
- A tool's first screen uses `ToolIntro` (`src/components/ToolIntro.tsx`); other empty lists use `Empty` from `src/components/ui.tsx`: one line, nothing else.

## Rule: never hide text
- No `truncate`, `line-clamp`, `text-ellipsis`, `text-overflow: ellipsis` or overflow hidden on text. Text wraps and the layout makes room (`min-w-0`, `flex-wrap`, `min-h-*`); long URLs, emails and ids use `wrap-anywhere`. `tests/ui-rules.test.ts` enforces it.

## Rule: popups on the floating layer
- Every menu, picker, popover and tooltip opens through `src/components/Floating.tsx` (`Floating`, `FloatingHere`, `HoverTip`, `Tip`, `OnTop`), never `absolute top-full` inside its box. `tests/floating.test.ts` enforces it.

## Rule: one brand style
- Follow `docs/brand.md` for the app, the website, emails and decks, with the tokens in `src/app/globals.css`. Tokens only, never a hex.
- Cards, panels, tables and charts are square. Buttons, inputs, menus and dialogs have 8px corners; tags 2px. Navy and white with one blue accent (`--pulse-blue`, about 3% of a screen). Serif for page titles and big numbers, Inter for everything else.
- No pills, no shadows on cards (only floating layers), no gradients, no emoji. `tests/ui-rules.test.ts` enforces it.

## Rule: dates and numbers through src/lib/format.ts
- Every date, money amount, percent and count on screen or in an email goes through `src/lib/format.ts` (en-US, the real minus sign, the formats in `docs/brand.md` section 10). No local `toLocaleString` or `Intl` calls.

## Rule: no technical setup for customers
- Connecting anything is one click through the tool's own sign-in ("Connect Stripe"). Never ask customers to paste API keys, tokens or webhook addresses in the main flow. Pasted keys are only a fallback, under Settings.

## Rule: everything people create can be deleted
- Every record, segment, goal, report, template, source and setting a person makes has a delete, confirmed with `askConfirm`. Lists also delete several at once. Deleting data or disconnecting a source really removes the rows.

## Rule: no sample data
- New workspaces start empty. Empty screens use `ToolIntro` and `Empty`.
- Marketing pages that show example numbers say "sample data".

## Rule: migrations
- `supabase/migrations/NNN_name.sql`, numbered with no gaps or duplicates (`tests/migrations.test.ts`). The runner on the VPS applies each new file from `main` in one transaction and records it in `ops.schema_migrations`.
- Each file runs inside a transaction (no `begin`/`commit`, no `create index concurrently`), is safe to run twice (`if not exists`, `drop policy if exists`, `on conflict do nothing`), and works with the code already live: drop or rename a column only after the code has stopped using it.
- Never add code fallbacks for a migration that hasn't run. Row level security on every table.

## Rule: one helper per job
- Retries: `src/lib/retry.ts`. Email: `sendEmail()` in `src/lib/email.ts`. Sealing tokens: `src/lib/seal.ts`. AI: `src/lib/ai.ts`. Never copy them; a test fails on a second copy of the Resend address.

## Rule: src/lib runs in Node too
- `src/lib` is run directly by Node in the tests and the worker: relative imports with the `.ts` extension, no `@/` paths in files the worker uses, and no TypeScript enums or other syntax Node can't strip.
- The worker stays in `worker/` with its own `worker/tsconfig.json`; the web build never sees it.

## Rule: production is main
- Production is `main`. Checks (`.github/workflows/checks.yml`) run on every push; images (`ghcr.io/dev-perceptric/pulsearr-web` and `pulsearr-worker`) are built only from `main` after Checks pass, and the VPS pulls them on its own. Migrations come only from `main`.
- The VPS is the only host. No Render, Fly or other host files.

## Rule: secrets
- `SECRETS_KEY` is set once and never rotated without a re-seal script. Sealed values carry the `v1:` prefix.
- Never put secrets in the repo, in logs, or in any text shown to customers. Server secrets live in env files on the VPS (`deploy/README.md`).

## Rule: professional words
- Copy is neutral and exact. Say what to do ("Payments to recover", "Needs a look"). Recover and cancel emails never blame the customer.
