-- PulseARR migration 008: connected Stripe accounts and clean copies of their billing objects (docs/m1-plan.md
-- section 4). The worker (service_role) writes every table here; signed-in members read their workspace's rows,
-- and nobody else reads or writes anything. Deleting a source deletes every row it brought in (on delete cascade),
-- and deleting a workspace deletes its sources.
--
--   workspaces.currency                 the currency MRR is counted in (lowercase ISO code, default 'usd')
--   sources                             one per connected Stripe account. Members read every column except the
--                                       sealed tokens and key (access_token, refresh_token, api_key: 'v1:' values
--                                       from src/lib/seal.ts), which only the server can read.
--   stripe_events                       every Stripe event once per source: id, type, created, the object it is
--                                       about, its customer, the keys of data.previous_attributes (`changed`),
--                                       received_at, processed_at. The MRR engine dates subscription changes from
--                                       customer.subscription.* rows by object_id.
--   stripe_customers, stripe_products, stripe_prices, stripe_coupons, stripe_subscriptions,
--   stripe_subscription_items, stripe_invoices, stripe_invoice_lines, stripe_charges, stripe_refunds
--                                       clean copies: (source_id, id) is the key, `id` is Stripe's id, typed columns
--                                       for lookups, `raw` is the object as Stripe returned it (what the engine
--                                       reads), updated_at is when the worker last wrote it. Invoice lines are keyed
--                                       by (source_id, invoice_id, id). Refunds carry their charge's customer_id,
--                                       filled by the sync, so a customer's rows load with one index each.
--   fx_rates                            daily rates (base, quote, day, rate): 1 base buys `rate` of quote. Loaded
--                                       nightly from the European Central Bank (base 'eur'). Not per workspace:
--                                       any signed-in person may read them.
-- Every clean table's (source_id, workspace_id) points at sources, so a row can't sit under the wrong workspace.

alter table public.workspaces add column if not exists currency text not null default 'usd' check (currency ~ '^[a-z]{3}$');

-- Sources ----------------------------------------------------------------------

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null check (kind in ('stripe_app', 'stripe_key')),
  account_id text not null check (account_id ~ '^acct_[A-Za-z0-9]+$'),
  account_name text check (char_length(account_name) <= 200),
  livemode boolean not null default true,
  -- Sealed with src/lib/seal.ts. Server only (no column grant to authenticated).
  access_token text check (access_token is null or access_token like 'v1:%'),
  refresh_token text check (refresh_token is null or refresh_token like 'v1:%'),
  api_key text check (api_key is null or api_key like 'v1:%'),
  token_expires_at timestamptz,
  status text not null default 'connecting' check (status in ('connecting', 'importing', 'live', 'error', 'disconnected')),
  -- Per object type: {"invoices": {"cursor": "in_...", "done": false, "count": 1200}, ...}
  backfill jsonb not null default '{}',
  last_event_id text,
  last_event_at timestamptz,
  last_synced_at timestamptz,
  last_error text check (char_length(last_error) <= 2000),
  connected_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, account_id),
  unique (id, workspace_id)
);
create index if not exists sources_account on public.sources (account_id);

-- Events -----------------------------------------------------------------------

create table if not exists public.stripe_events (
  source_id uuid not null,
  workspace_id uuid not null,
  id text not null check (id ~ '^evt_'),
  type text not null,
  created timestamptz not null,
  object_id text,
  customer_id text,
  changed text[],
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (source_id, id),
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade
);
create index if not exists stripe_events_object on public.stripe_events (source_id, object_id, created);
create index if not exists stripe_events_unprocessed on public.stripe_events (source_id, received_at) where processed_at is null;

-- Clean copies -----------------------------------------------------------------

create table if not exists public.stripe_customers (
  source_id uuid not null,
  workspace_id uuid not null,
  id text not null,
  email text,
  name text,
  currency text,
  created timestamptz,
  deleted boolean not null default false,
  raw jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (source_id, id),
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade
);
create index if not exists stripe_customers_workspace on public.stripe_customers (workspace_id);

create table if not exists public.stripe_products (
  source_id uuid not null,
  workspace_id uuid not null,
  id text not null,
  name text,
  active boolean,
  created timestamptz,
  raw jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (source_id, id),
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade
);

create table if not exists public.stripe_prices (
  source_id uuid not null,
  workspace_id uuid not null,
  id text not null,
  product_id text,
  currency text,
  type text check (type in ('recurring', 'one_time')),
  billing_scheme text,
  tiers_mode text,
  unit_amount bigint,
  unit_amount_decimal numeric,
  interval text check (interval in ('day', 'week', 'month', 'year')),
  interval_count int,
  usage_type text check (usage_type in ('licensed', 'metered')),
  active boolean,
  created timestamptz,
  raw jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (source_id, id),
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade
);

create table if not exists public.stripe_coupons (
  source_id uuid not null,
  workspace_id uuid not null,
  id text not null,
  name text,
  percent_off numeric,
  amount_off bigint,
  currency text,
  duration text check (duration in ('once', 'repeating', 'forever')),
  duration_in_months int,
  valid boolean,
  created timestamptz,
  raw jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (source_id, id),
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade
);

create table if not exists public.stripe_subscriptions (
  source_id uuid not null,
  workspace_id uuid not null,
  id text not null,
  customer_id text not null,
  status text not null,
  currency text,
  created timestamptz,
  start_date timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_start timestamptz,
  trial_end timestamptz,
  cancel_at timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  ended_at timestamptz,
  pause_collection jsonb,
  raw jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (source_id, id),
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade
);
create index if not exists stripe_subscriptions_customer on public.stripe_subscriptions (source_id, customer_id);

create table if not exists public.stripe_subscription_items (
  source_id uuid not null,
  workspace_id uuid not null,
  id text not null,
  subscription_id text not null,
  price_id text,
  quantity bigint,
  created timestamptz,
  raw jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (source_id, id),
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade
);
create index if not exists stripe_subscription_items_subscription on public.stripe_subscription_items (source_id, subscription_id);

create table if not exists public.stripe_invoices (
  source_id uuid not null,
  workspace_id uuid not null,
  id text not null,
  customer_id text not null,
  subscription_id text,
  status text check (status in ('draft', 'open', 'paid', 'uncollectible', 'void')),
  billing_reason text,
  collection_method text,
  currency text,
  created timestamptz,
  due_date timestamptz,
  finalized_at timestamptz,
  paid_at timestamptz,
  amount_due bigint,
  amount_paid bigint,
  amount_remaining bigint,
  subtotal bigint,
  total bigint,
  raw jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (source_id, id),
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade
);
create index if not exists stripe_invoices_customer on public.stripe_invoices (source_id, customer_id);
create index if not exists stripe_invoices_subscription on public.stripe_invoices (source_id, subscription_id);

create table if not exists public.stripe_invoice_lines (
  source_id uuid not null,
  workspace_id uuid not null,
  invoice_id text not null,
  id text not null,
  customer_id text not null,
  subscription_id text,
  subscription_item_id text,
  price_id text,
  type text,
  proration boolean not null default false,
  quantity bigint,
  amount bigint,
  discount_amount bigint not null default 0,
  currency text,
  period_start timestamptz,
  period_end timestamptz,
  raw jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (source_id, invoice_id, id),
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade,
  foreign key (source_id, invoice_id) references public.stripe_invoices (source_id, id) on delete cascade
);
create index if not exists stripe_invoice_lines_customer on public.stripe_invoice_lines (source_id, customer_id);

create table if not exists public.stripe_charges (
  source_id uuid not null,
  workspace_id uuid not null,
  id text not null,
  customer_id text,
  invoice_id text,
  payment_intent_id text,
  status text check (status in ('succeeded', 'pending', 'failed')),
  amount bigint,
  amount_refunded bigint,
  currency text,
  paid boolean,
  refunded boolean,
  failure_code text,
  failure_message text,
  created timestamptz,
  raw jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (source_id, id),
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade
);
create index if not exists stripe_charges_customer on public.stripe_charges (source_id, customer_id);

create table if not exists public.stripe_refunds (
  source_id uuid not null,
  workspace_id uuid not null,
  id text not null,
  charge_id text,
  customer_id text,
  amount bigint,
  currency text,
  status text,
  reason text,
  created timestamptz,
  raw jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (source_id, id),
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade
);
create index if not exists stripe_refunds_customer on public.stripe_refunds (source_id, customer_id);
create index if not exists stripe_refunds_charge on public.stripe_refunds (source_id, charge_id);

-- Currency rates ---------------------------------------------------------------

create table if not exists public.fx_rates (
  base text not null check (base ~ '^[a-z]{3}$'),
  quote text not null check (quote ~ '^[a-z]{3}$'),
  day date not null,
  rate numeric not null check (rate > 0),
  created_at timestamptz not null default now(),
  primary key (base, quote, day),
  check (base <> quote)
);

-- Row level security -----------------------------------------------------------
-- Read only for members; the server writes. The token columns of sources are left out of the column grant.

alter table public.sources enable row level security;
alter table public.stripe_events enable row level security;
alter table public.stripe_customers enable row level security;
alter table public.stripe_products enable row level security;
alter table public.stripe_prices enable row level security;
alter table public.stripe_coupons enable row level security;
alter table public.stripe_subscriptions enable row level security;
alter table public.stripe_subscription_items enable row level security;
alter table public.stripe_invoices enable row level security;
alter table public.stripe_invoice_lines enable row level security;
alter table public.stripe_charges enable row level security;
alter table public.stripe_refunds enable row level security;
alter table public.fx_rates enable row level security;

drop policy if exists "members read" on public.sources;
create policy "members read" on public.sources for select to authenticated using (is_member(workspace_id));
drop policy if exists "members read" on public.stripe_events;
create policy "members read" on public.stripe_events for select to authenticated using (is_member(workspace_id));
drop policy if exists "members read" on public.stripe_customers;
create policy "members read" on public.stripe_customers for select to authenticated using (is_member(workspace_id));
drop policy if exists "members read" on public.stripe_products;
create policy "members read" on public.stripe_products for select to authenticated using (is_member(workspace_id));
drop policy if exists "members read" on public.stripe_prices;
create policy "members read" on public.stripe_prices for select to authenticated using (is_member(workspace_id));
drop policy if exists "members read" on public.stripe_coupons;
create policy "members read" on public.stripe_coupons for select to authenticated using (is_member(workspace_id));
drop policy if exists "members read" on public.stripe_subscriptions;
create policy "members read" on public.stripe_subscriptions for select to authenticated using (is_member(workspace_id));
drop policy if exists "members read" on public.stripe_subscription_items;
create policy "members read" on public.stripe_subscription_items for select to authenticated using (is_member(workspace_id));
drop policy if exists "members read" on public.stripe_invoices;
create policy "members read" on public.stripe_invoices for select to authenticated using (is_member(workspace_id));
drop policy if exists "members read" on public.stripe_invoice_lines;
create policy "members read" on public.stripe_invoice_lines for select to authenticated using (is_member(workspace_id));
drop policy if exists "members read" on public.stripe_charges;
create policy "members read" on public.stripe_charges for select to authenticated using (is_member(workspace_id));
drop policy if exists "members read" on public.stripe_refunds;
create policy "members read" on public.stripe_refunds for select to authenticated using (is_member(workspace_id));
drop policy if exists "signed in read" on public.fx_rates;
create policy "signed in read" on public.fx_rates for select to authenticated using (true);

revoke all on public.sources, public.stripe_events, public.stripe_customers, public.stripe_products, public.stripe_prices,
  public.stripe_coupons, public.stripe_subscriptions, public.stripe_subscription_items, public.stripe_invoices,
  public.stripe_invoice_lines, public.stripe_charges, public.stripe_refunds, public.fx_rates
  from public, anon, authenticated;
grant select (id, workspace_id, kind, account_id, account_name, livemode, status, backfill, last_event_id, last_event_at,
  last_synced_at, last_error, connected_by, created_at, updated_at) on public.sources to authenticated;
grant select on public.stripe_events, public.stripe_customers, public.stripe_products, public.stripe_prices,
  public.stripe_coupons, public.stripe_subscriptions, public.stripe_subscription_items, public.stripe_invoices,
  public.stripe_invoice_lines, public.stripe_charges, public.stripe_refunds, public.fx_rates
  to authenticated;
grant all on public.sources, public.stripe_events, public.stripe_customers, public.stripe_products, public.stripe_prices,
  public.stripe_coupons, public.stripe_subscriptions, public.stripe_subscription_items, public.stripe_invoices,
  public.stripe_invoice_lines, public.stripe_charges, public.stripe_refunds, public.fx_rates
  to service_role;
