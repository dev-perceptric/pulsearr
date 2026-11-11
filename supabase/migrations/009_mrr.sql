-- PulseARR migration 009: MRR movements, each customer's MRR over time, daily totals, the live feed, and the read
-- functions behind the dashboard, metric pages and feed (docs/m1-plan.md sections 3 and 4). The worker writes
-- through replace_customer_mrr and rebuild_mrr_daily (service_role only). Members read their workspace's rows,
-- and the read functions run as the caller (security invoker), so row level security decides: a non-member gets
-- no rows (series, summary, movements, feed) or null (metric_window).
--
-- Money is whole cents in the workspace currency (workspaces.currency). Rates are fractions (0.05 is 5%).
-- In mrr_daily, contraction_mrr and churned_mrr are positive amounts lost; movements keep their sign.
--
-- Metrics over a window [from, to] (a period of metric_series, or the range of metric_summary). "At start" is the
-- end of the day before `from`; "at end" is the end of `to`. A stock is the latest mrr_daily row on or before that
-- day (none: 0). Any division by 0 is null.
--   mrr                  MRR at end
--   arr                  MRR at end x 12
--   new_mrr, expansion_mrr, reactivation_mrr, contraction_mrr, churned_mrr
--                        the sum of that kind of movement in the window (contraction and churned as positive)
--   net_new_mrr          new + expansion + reactivation - contraction - churned
--   active_customers     customers with MRR above 0 at end
--   new_customers        customers whose first MRR began in the window
--   arpu                 MRR at end / active customers at end
--   customer_churn_rate  churned customers in the window / active customers at start
--   revenue_churn_rate   (churned + contraction) / MRR at start
--   nrr                  of the customers with MRR at start: their MRR at end / their MRR at start
--   grr                  of the customers with MRR at start: the sum of least(MRR at end, MRR at start) / their MRR at start
--   ltv                  ARPU at end / monthly customer churn rate, where the monthly rate is the churned customers
--                        in the 30 days ending at `to` / active customers the day before those 30 days
--   quick_ratio          (new + expansion + reactivation) / (contraction + churned)
--
--   rebuild_mrr_daily(p_ws uuid, p_from date default null) returns int
--     Recompute mrr_daily from p_from (null: the first movement) to today (UTC) from mrr_movements: every day gets
--     a row. Rows before p_from stay. Returns the rows written. One at a time per workspace. Server only.
--   replace_customer_mrr(p_ws uuid, p_source uuid, p_customer text, p_movements jsonb, p_days jsonb, p_feed jsonb) returns date
--     In one transaction: replace that customer's mrr_movements, mrr_customer_days and feed_items with the given
--     rows (arrays of objects with the column names), then rebuild_mrr_daily from the earliest day whose movements
--     changed. Returns that day, or null when the movements didn't change (or the source is gone). Server only.
--   metric_window(p_ws uuid, p_metric text, p_from date, p_to date) returns numeric
--   metric_series(p_ws uuid, p_metric text, p_from date, p_to date, p_interval text) returns table (period date, value numeric)
--     One row per day, week (from Monday), month, quarter or year from the one holding p_from to the one holding
--     p_to, labeled with its first day. Days outside [p_from, p_to] don't count. At most 1500 rows.
--   metric_summary(p_ws uuid, p_from date, p_to date) returns table (metric text, value numeric, previous numeric, change numeric, change_pct numeric)
--     Every metric over [p_from, p_to] and over the window of the same length just before it; change is value -
--     previous, change_pct is change / |previous|.
--   metric_movements(p_ws uuid, p_metric text, p_from date, p_to date) returns table (...)
--     The movements behind a metric in [p_from, p_to], with the customer's name and email, newest and largest
--     first. new_mrr and new_customers: new; expansion_mrr: expansion; reactivation_mrr: reactivation;
--     contraction_mrr: contraction; churned_mrr and customer_churn_rate: churn; revenue_churn_rate and grr:
--     churn and contraction; nrr: expansion, contraction and churn; active_customers: new, reactivation and
--     churn; the rest: every kind.
--   feed(p_ws uuid, p_before timestamptz default null, p_limit int default 50) returns table (...)
--     Feed items before p_before (null: all), newest first, at most p_limit (1..200).

-- Movements --------------------------------------------------------------------

create table if not exists public.mrr_movements (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  source_id uuid not null,
  customer_id text not null,
  subscription_id text,
  day date not null,
  at timestamptz not null,
  kind text not null check (kind in ('new', 'expansion', 'contraction', 'churn', 'reactivation')),
  amount bigint not null check (amount <> 0),
  mrr_before bigint not null check (mrr_before >= 0),
  mrr_after bigint not null check (mrr_after >= 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  original_amount bigint not null,
  original_currency text not null check (original_currency ~ '^[a-z]{3}$'),
  rate numeric not null check (rate > 0),
  cause_type text not null check (cause_type in ('invoice', 'subscription', 'event')),
  cause_id text not null,
  created_at timestamptz not null default now(),
  check (mrr_after - mrr_before = amount),
  check ((kind in ('new', 'expansion', 'reactivation')) = (amount > 0)),
  check (kind not in ('new', 'reactivation') or mrr_before = 0),
  check (kind <> 'churn' or mrr_after = 0),
  check (kind not in ('expansion', 'contraction') or (mrr_before > 0 and mrr_after > 0)),
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade
);
create index if not exists mrr_movements_workspace_day on public.mrr_movements (workspace_id, day);
create index if not exists mrr_movements_customer on public.mrr_movements (source_id, customer_id, day);

-- Each customer's MRR from one day until the day before to_day (null: still) --------------------------------------

create table if not exists public.mrr_customer_days (
  workspace_id uuid not null,
  source_id uuid not null,
  customer_id text not null,
  from_day date not null,
  to_day date,
  mrr bigint not null check (mrr >= 0),
  mrr_native bigint not null check (mrr_native >= 0),
  native_currency text not null check (native_currency ~ '^[a-z]{3}$'),
  rate numeric not null check (rate > 0),
  primary key (source_id, customer_id, from_day),
  check (to_day is null or to_day > from_day),
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade
);
create index if not exists mrr_customer_days_workspace on public.mrr_customer_days (workspace_id, from_day);
create index if not exists mrr_customer_days_current on public.mrr_customer_days (workspace_id) where to_day is null;

-- Daily totals -----------------------------------------------------------------

create table if not exists public.mrr_daily (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  day date not null,
  mrr bigint not null,
  arr bigint not null,
  new_mrr bigint not null default 0,
  expansion_mrr bigint not null default 0,
  reactivation_mrr bigint not null default 0,
  contraction_mrr bigint not null default 0,
  churned_mrr bigint not null default 0,
  net_new_mrr bigint not null default 0,
  active_customers int not null default 0,
  new_customers int not null default 0,
  reactivated_customers int not null default 0,
  churned_customers int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, day)
);

-- The live feed ----------------------------------------------------------------

create table if not exists public.feed_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  source_id uuid not null,
  customer_id text not null,
  key text not null check (char_length(key) <= 300),
  kind text not null check (kind in ('signup', 'upgrade', 'downgrade', 'cancel', 'reactivation', 'failed_payment', 'refund')),
  at timestamptz not null,
  amount bigint not null,
  currency text not null,
  original_amount bigint not null,
  original_currency text not null,
  object_type text not null check (object_type in ('invoice', 'subscription', 'event', 'charge', 'refund')),
  object_id text not null,
  created_at timestamptz not null default now(),
  unique (source_id, key),
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade
);
create index if not exists feed_items_workspace_at on public.feed_items (workspace_id, at desc, id desc);
create index if not exists feed_items_customer on public.feed_items (source_id, customer_id);

-- Row level security -----------------------------------------------------------

alter table public.mrr_movements enable row level security;
alter table public.mrr_customer_days enable row level security;
alter table public.mrr_daily enable row level security;
alter table public.feed_items enable row level security;

drop policy if exists "members read" on public.mrr_movements;
create policy "members read" on public.mrr_movements for select to authenticated using (is_member(workspace_id));
drop policy if exists "members read" on public.mrr_customer_days;
create policy "members read" on public.mrr_customer_days for select to authenticated using (is_member(workspace_id));
drop policy if exists "members read" on public.mrr_daily;
create policy "members read" on public.mrr_daily for select to authenticated using (is_member(workspace_id));
drop policy if exists "members read" on public.feed_items;
create policy "members read" on public.feed_items for select to authenticated using (is_member(workspace_id));

revoke all on public.mrr_movements, public.mrr_customer_days, public.mrr_daily, public.feed_items from public, anon, authenticated;
revoke all on sequence public.mrr_movements_id_seq from public, anon, authenticated;
grant select on public.mrr_movements, public.mrr_customer_days, public.mrr_daily, public.feed_items to authenticated;
grant all on public.mrr_movements, public.mrr_customer_days, public.mrr_daily, public.feed_items to service_role;
grant usage, select on sequence public.mrr_movements_id_seq to service_role;

-- Writing ----------------------------------------------------------------------

create or replace function public.rebuild_mrr_daily(p_ws uuid, p_from date default null) returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_first date;
  v_last date;
  v_from date;
  n int;
begin
  if p_ws is null then raise exception 'A workspace is needed'; end if;
  -- One rebuild at a time per workspace, so two customers' jobs can't interleave their rows.
  perform pg_advisory_xact_lock(hashtextextended('mrr_daily:' || p_ws::text, 0));
  select min(day), max(day) into v_first, v_last from mrr_movements where workspace_id = p_ws;
  v_from := coalesce(p_from, v_first);
  if v_from is null then
    delete from mrr_daily where workspace_id = p_ws;
    return 0;
  end if;
  delete from mrr_daily where workspace_id = p_ws and day >= v_from;
  if v_first is null then return 0; end if;
  v_from := greatest(v_from, v_first);
  v_last := greatest(v_last, (now() at time zone 'utc')::date);

  insert into mrr_daily (workspace_id, day, mrr, arr, new_mrr, expansion_mrr, reactivation_mrr, contraction_mrr, churned_mrr,
                         net_new_mrr, active_customers, new_customers, reactivated_customers, churned_customers, updated_at)
  select p_ws, r.day, r.mrr, r.mrr * 12, r.new_mrr, r.expansion_mrr, r.reactivation_mrr, r.contraction_mrr, r.churned_mrr,
         r.net, r.active, r.new_c, r.react_c, r.churn_c, now()
  from (
    with base as (
      select coalesce((select sum(amount) from mrr_movements where workspace_id = p_ws and day < v_from), 0)::bigint as mrr,
             (select count(*) from (
                select 1 from mrr_movements where workspace_id = p_ws and day < v_from
                group by source_id, customer_id having sum(amount) > 0) x)::int as active
    ),
    per_day as (
      select m.day,
             coalesce(sum(m.amount) filter (where m.kind = 'new'), 0)::bigint as new_mrr,
             coalesce(sum(m.amount) filter (where m.kind = 'expansion'), 0)::bigint as expansion_mrr,
             coalesce(sum(m.amount) filter (where m.kind = 'reactivation'), 0)::bigint as reactivation_mrr,
             coalesce(-sum(m.amount) filter (where m.kind = 'contraction'), 0)::bigint as contraction_mrr,
             coalesce(-sum(m.amount) filter (where m.kind = 'churn'), 0)::bigint as churned_mrr,
             sum(m.amount)::bigint as net,
             (count(*) filter (where m.kind = 'new'))::int as new_c,
             (count(*) filter (where m.kind = 'reactivation'))::int as react_c,
             (count(*) filter (where m.kind = 'churn'))::int as churn_c
      from mrr_movements m
      where m.workspace_id = p_ws and m.day >= v_from
      group by m.day
    ),
    days as (
      select g::date as day from generate_series(v_from::timestamp, v_last::timestamp, interval '1 day') g
    )
    select d.day,
           (b.mrr + sum(coalesce(p.net, 0)) over w)::bigint as mrr,
           coalesce(p.new_mrr, 0) as new_mrr, coalesce(p.expansion_mrr, 0) as expansion_mrr,
           coalesce(p.reactivation_mrr, 0) as reactivation_mrr, coalesce(p.contraction_mrr, 0) as contraction_mrr,
           coalesce(p.churned_mrr, 0) as churned_mrr, coalesce(p.net, 0) as net,
           (b.active + sum(coalesce(p.new_c + p.react_c - p.churn_c, 0)) over w)::int as active,
           coalesce(p.new_c, 0) as new_c, coalesce(p.react_c, 0) as react_c, coalesce(p.churn_c, 0) as churn_c
    from days d cross join base b left join per_day p on p.day = d.day
    window w as (order by d.day rows between unbounded preceding and current row)
  ) r;
  get diagnostics n = row_count;
  return n;
end;
$fn$;

create or replace function public.replace_customer_mrr(p_ws uuid, p_source uuid, p_customer text, p_movements jsonb, p_days jsonb, p_feed jsonb)
returns date
language plpgsql security definer set search_path = public as $fn$
declare
  v_changed date;
begin
  if coalesce(p_customer, '') = '' then raise exception 'A customer is needed'; end if;
  perform 1 from sources where id = p_source and workspace_id = p_ws;
  if not found then return null; end if; -- disconnected: its rows went with it
  perform pg_advisory_xact_lock(hashtextextended('mrr_customer:' || p_source::text || ':' || p_customer, 0));

  with old as (
    delete from mrr_movements where source_id = p_source and customer_id = p_customer
    returning day, kind, amount
  ), fresh as (
    insert into mrr_movements (workspace_id, source_id, customer_id, subscription_id, day, at, kind, amount, mrr_before, mrr_after,
                               currency, original_amount, original_currency, rate, cause_type, cause_id)
    select p_ws, p_source, p_customer, m.subscription_id, m.day, m.at, m.kind, m.amount, m.mrr_before, m.mrr_after,
           m.currency, m.original_amount, m.original_currency, m.rate, m.cause_type, m.cause_id
    from jsonb_to_recordset(coalesce(p_movements, '[]'::jsonb)) as m(subscription_id text, day date, at timestamptz, kind text,
      amount bigint, mrr_before bigint, mrr_after bigint, currency text, original_amount bigint, original_currency text,
      rate numeric, cause_type text, cause_id text)
    returning day, kind, amount
  ), diff as (
    (select day, kind, amount from old except all select day, kind, amount from fresh)
    union all
    (select day, kind, amount from fresh except all select day, kind, amount from old)
  )
  select min(day) into v_changed from diff;

  delete from mrr_customer_days where source_id = p_source and customer_id = p_customer;
  insert into mrr_customer_days (workspace_id, source_id, customer_id, from_day, to_day, mrr, mrr_native, native_currency, rate)
  select p_ws, p_source, p_customer, d.from_day, d.to_day, d.mrr, d.mrr_native, d.native_currency, d.rate
  from jsonb_to_recordset(coalesce(p_days, '[]'::jsonb)) as d(from_day date, to_day date, mrr bigint, mrr_native bigint,
    native_currency text, rate numeric);

  delete from feed_items where source_id = p_source and customer_id = p_customer;
  insert into feed_items (workspace_id, source_id, customer_id, key, kind, at, amount, currency, original_amount, original_currency,
                          object_type, object_id)
  select p_ws, p_source, p_customer, f.key, f.kind, f.at, f.amount, f.currency, f.original_amount, f.original_currency,
         f.object_type, f.object_id
  from jsonb_to_recordset(coalesce(p_feed, '[]'::jsonb)) as f(key text, kind text, at timestamptz, amount bigint, currency text,
    original_amount bigint, original_currency text, object_type text, object_id text);

  if v_changed is not null then perform rebuild_mrr_daily(p_ws, v_changed); end if;
  return v_changed;
end;
$fn$;

-- Reading ----------------------------------------------------------------------

create or replace function public.metric_kinds(p_metric text) returns text[]
language plpgsql immutable set search_path = public as $fn$
begin
  return case p_metric
    when 'new_mrr' then array['new']
    when 'new_customers' then array['new']
    when 'expansion_mrr' then array['expansion']
    when 'reactivation_mrr' then array['reactivation']
    when 'contraction_mrr' then array['contraction']
    when 'churned_mrr' then array['churn']
    when 'customer_churn_rate' then array['churn']
    when 'revenue_churn_rate' then array['churn', 'contraction']
    when 'grr' then array['churn', 'contraction']
    when 'nrr' then array['expansion', 'contraction', 'churn']
    when 'active_customers' then array['new', 'reactivation', 'churn']
    when 'mrr' then array['new', 'expansion', 'reactivation', 'contraction', 'churn']
    when 'arr' then array['new', 'expansion', 'reactivation', 'contraction', 'churn']
    when 'net_new_mrr' then array['new', 'expansion', 'reactivation', 'contraction', 'churn']
    when 'arpu' then array['new', 'expansion', 'reactivation', 'contraction', 'churn']
    when 'ltv' then array['new', 'expansion', 'reactivation', 'contraction', 'churn']
    when 'quick_ratio' then array['new', 'expansion', 'reactivation', 'contraction', 'churn']
    else null
  end;
end;
$fn$;

create or replace function public.metric_window(p_ws uuid, p_metric text, p_from date, p_to date) returns numeric
language plpgsql stable security invoker set search_path = public as $fn$
declare
  s_mrr numeric;
  s_active numeric;
  e_mrr numeric;
  e_active numeric;
  f record;
  v numeric;
  churn30 numeric;
  active30 numeric;
begin
  if metric_kinds(p_metric) is null then raise exception 'Unknown metric'; end if;
  if p_ws is null or p_from is null or p_to is null or p_to < p_from then return null; end if;
  -- The caller can't see the workspace: nothing.
  if not exists (select 1 from workspaces w where w.id = p_ws) then return null; end if;

  select d.mrr, d.active_customers into s_mrr, s_active from mrr_daily d where d.workspace_id = p_ws and d.day < p_from order by d.day desc limit 1;
  select d.mrr, d.active_customers into e_mrr, e_active from mrr_daily d where d.workspace_id = p_ws and d.day <= p_to order by d.day desc limit 1;
  s_mrr := coalesce(s_mrr, 0);
  s_active := coalesce(s_active, 0);
  e_mrr := coalesce(e_mrr, 0);
  e_active := coalesce(e_active, 0);
  select coalesce(sum(d.new_mrr), 0)::numeric as new_mrr, coalesce(sum(d.expansion_mrr), 0)::numeric as expansion_mrr,
         coalesce(sum(d.reactivation_mrr), 0)::numeric as reactivation_mrr, coalesce(sum(d.contraction_mrr), 0)::numeric as contraction_mrr,
         coalesce(sum(d.churned_mrr), 0)::numeric as churned_mrr, coalesce(sum(d.new_customers), 0)::numeric as new_customers,
         coalesce(sum(d.churned_customers), 0)::numeric as churned_customers
    into f
  from mrr_daily d where d.workspace_id = p_ws and d.day between p_from and p_to;

  if p_metric in ('nrr', 'grr') then
    select case when p_metric = 'nrr' then sum(c.end_mrr) else sum(least(c.end_mrr, c.start_mrr)) end / nullif(sum(c.start_mrr), 0)
      into v
    from (
      select coalesce(sum(x.mrr) filter (where x.from_day < p_from and (x.to_day is null or x.to_day >= p_from)), 0)::numeric as start_mrr,
             coalesce(sum(x.mrr) filter (where x.from_day <= p_to and (x.to_day is null or x.to_day > p_to)), 0)::numeric as end_mrr
      from mrr_customer_days x
      where x.workspace_id = p_ws and x.from_day <= p_to and (x.to_day is null or x.to_day >= p_from)
      group by x.source_id, x.customer_id
    ) c
    where c.start_mrr > 0;
    return v;
  end if;

  if p_metric = 'ltv' then
    select coalesce(sum(d.churned_customers), 0) into churn30 from mrr_daily d where d.workspace_id = p_ws and d.day between p_to - 29 and p_to;
    select d.active_customers into active30 from mrr_daily d where d.workspace_id = p_ws and d.day < p_to - 29 order by d.day desc limit 1;
    if coalesce(active30, 0) = 0 or churn30 = 0 or e_active = 0 then return null; end if;
    return (e_mrr / e_active) / (churn30 / active30);
  end if;

  return case p_metric
    when 'mrr' then e_mrr
    when 'arr' then e_mrr * 12
    when 'new_mrr' then f.new_mrr
    when 'expansion_mrr' then f.expansion_mrr
    when 'reactivation_mrr' then f.reactivation_mrr
    when 'contraction_mrr' then f.contraction_mrr
    when 'churned_mrr' then f.churned_mrr
    when 'net_new_mrr' then f.new_mrr + f.expansion_mrr + f.reactivation_mrr - f.contraction_mrr - f.churned_mrr
    when 'active_customers' then e_active
    when 'new_customers' then f.new_customers
    when 'arpu' then e_mrr / nullif(e_active, 0)
    when 'customer_churn_rate' then f.churned_customers / nullif(s_active, 0)
    when 'revenue_churn_rate' then (f.churned_mrr + f.contraction_mrr) / nullif(s_mrr, 0)
    when 'quick_ratio' then (f.new_mrr + f.expansion_mrr + f.reactivation_mrr) / nullif(f.contraction_mrr + f.churned_mrr, 0)
  end;
end;
$fn$;

create or replace function public.metric_series(p_ws uuid, p_metric text, p_from date, p_to date, p_interval text)
returns table (period date, value numeric)
language plpgsql stable security invoker set search_path = public as $fn$
declare
  step interval;
begin
  if metric_kinds(p_metric) is null then raise exception 'Unknown metric'; end if;
  if p_interval is null or p_interval not in ('day', 'week', 'month', 'quarter', 'year') then raise exception 'Pick day, week, month, quarter or year'; end if;
  if p_ws is null or p_from is null or p_to is null or p_to < p_from then return; end if;
  if not exists (select 1 from workspaces w where w.id = p_ws) then return; end if;
  step := case p_interval when 'quarter' then interval '3 months' else ('1 ' || p_interval)::interval end;
  if (select count(*) from generate_series(date_trunc(p_interval, p_from::timestamp), p_to::timestamp, step)) > 1500 then
    raise exception 'Pick a shorter range';
  end if;
  return query
  select g::date, metric_window(p_ws, p_metric, greatest(g::date, p_from), least((g + step)::date - 1, p_to))
  from generate_series(date_trunc(p_interval, p_from::timestamp), p_to::timestamp, step) g
  order by 1;
end;
$fn$;

create or replace function public.metric_summary(p_ws uuid, p_from date, p_to date)
returns table (metric text, value numeric, previous numeric, change numeric, change_pct numeric)
language sql stable security invoker set search_path = public as $fn$
  select x.m, x.cur, x.prev, x.cur - x.prev, (x.cur - x.prev) / nullif(abs(x.prev), 0)
  from (
    select m.m, m.o,
           metric_window(p_ws, m.m, p_from, p_to) as cur,
           metric_window(p_ws, m.m, p_from - (p_to - p_from + 1), p_from - 1) as prev
    from unnest(array['mrr', 'arr', 'net_new_mrr', 'new_mrr', 'expansion_mrr', 'reactivation_mrr', 'contraction_mrr', 'churned_mrr',
                      'active_customers', 'new_customers', 'arpu', 'customer_churn_rate', 'revenue_churn_rate', 'nrr', 'grr', 'ltv',
                      'quick_ratio']) with ordinality as m(m, o)
    where p_to >= p_from and exists (select 1 from workspaces w where w.id = p_ws)
  ) x
  order by x.o
$fn$;

create or replace function public.metric_movements(p_ws uuid, p_metric text, p_from date, p_to date)
returns table (day date, at timestamptz, source_id uuid, customer_id text, customer_name text, customer_email text, subscription_id text,
               kind text, amount bigint, mrr_before bigint, mrr_after bigint, currency text, original_amount bigint,
               original_currency text, rate numeric, cause_type text, cause_id text)
language sql stable security invoker set search_path = public as $fn$
  select m.day, m.at, m.source_id, m.customer_id, c.name, c.email, m.subscription_id, m.kind, m.amount, m.mrr_before, m.mrr_after,
         m.currency, m.original_amount, m.original_currency, m.rate, m.cause_type, m.cause_id
  from mrr_movements m
  left join stripe_customers c on c.source_id = m.source_id and c.id = m.customer_id
  where m.workspace_id = p_ws and m.day between p_from and p_to and m.kind = any (metric_kinds(p_metric))
  order by m.day desc, abs(m.amount) desc, m.customer_id, m.id
$fn$;

create or replace function public.feed(p_ws uuid, p_before timestamptz default null, p_limit int default 50)
returns table (id uuid, at timestamptz, kind text, source_id uuid, customer_id text, customer_name text, customer_email text,
               amount bigint, currency text, original_amount bigint, original_currency text, object_type text, object_id text)
language sql stable security invoker set search_path = public as $fn$
  select f.id, f.at, f.kind, f.source_id, f.customer_id, c.name, c.email, f.amount, f.currency, f.original_amount,
         f.original_currency, f.object_type, f.object_id
  from feed_items f
  left join stripe_customers c on c.source_id = f.source_id and c.id = f.customer_id
  where f.workspace_id = p_ws and (p_before is null or f.at < p_before)
  order by f.at desc, f.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$fn$;

revoke all on function public.rebuild_mrr_daily(uuid, date) from public, anon, authenticated;
revoke all on function public.replace_customer_mrr(uuid, uuid, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.metric_kinds(text) from public, anon;
revoke all on function public.metric_window(uuid, text, date, date) from public, anon;
revoke all on function public.metric_series(uuid, text, date, date, text) from public, anon;
revoke all on function public.metric_summary(uuid, date, date) from public, anon;
revoke all on function public.metric_movements(uuid, text, date, date) from public, anon;
revoke all on function public.feed(uuid, timestamptz, int) from public, anon;
grant execute on function public.rebuild_mrr_daily(uuid, date) to service_role;
grant execute on function public.replace_customer_mrr(uuid, uuid, text, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.metric_kinds(text) to authenticated, service_role;
grant execute on function public.metric_window(uuid, text, date, date) to authenticated, service_role;
grant execute on function public.metric_series(uuid, text, date, date, text) to authenticated, service_role;
grant execute on function public.metric_summary(uuid, date, date) to authenticated, service_role;
grant execute on function public.metric_movements(uuid, text, date, date) to authenticated, service_role;
grant execute on function public.feed(uuid, timestamptz, int) to authenticated, service_role;
