-- PulseARR migration 010: connecting, syncing and removing Stripe sources (docs/m1-plan.md sections 1 and 2). The
-- web app calls these over the server key, the worker over pg; all of them are service_role only.
--
--   connect_source(p_ws uuid, p_user uuid, p_kind text, p_account text, p_name text, p_livemode boolean, p_access text,
--                  p_refresh text, p_api_key text, p_expires_at timestamptz, p_currency text, p_objects text[]) returns uuid
--     Add the source, or update the one this workspace already has for that account: new sealed tokens or key,
--     status 'importing', backfill progress cleared. Sets the workspace currency to p_currency when the workspace
--     has no data yet (no other source and no movements). Enqueues one 'stripe.backfill' per object in p_objects
--     (key '<source>:<object>', payload {source_id, object}) and a first 'stripe.poll_events' (key '<source>').
--     Returns the source id.
--
--   record_stripe_events(p_source uuid, p_events jsonb) returns int
--     Store each event once (an array of {id, type, created, object_id, customer_id, changed, sync_type, sync_id};
--     a repeat is skipped), and for each new one with a sync_type enqueue 'stripe.sync_object' (key
--     '<source>:<sync_id>', payload {source_id, object_type, object_id}). Returns how many were new. A source that
--     is gone or disconnected stores nothing.
--   record_stripe_event(p_account text, p_livemode boolean, p_event jsonb) returns int
--     The webhook's entry: record_stripe_events for every source connected to that account in that mode. Returns
--     how many sources know the account (0: an account we don't have, ignored).
--   source_deauthorized(p_account text, p_livemode boolean) returns int
--     The app was removed in Stripe: its sources are disconnected and their tokens wiped. Data stays until deleted.
--   delete_source(p_source uuid) returns uuid
--     Delete the source (its rows go by cascade) and its waiting jobs, then rebuild the workspace's mrr_daily from
--     scratch. Returns the workspace id, or null when there was no such source.
--   enqueue_job_once(p_ws uuid, p_kind text, p_key text, p_payload jsonb) returns uuid
--     enqueue_job unless a job with that workspace, kind and key exists in any state (nightly work keyed by day).
--     Null when it already exists.
--   due_stripe_polls(p_every_s int default 300) returns int
--     Enqueue 'stripe.poll_events' for each importing or live source not synced in p_every_s seconds and with no
--     poll waiting or running. Returns how many.
--   replace_customer_mrr(..., p_daily boolean)
--     As 009's, with p_daily false leaving mrr_daily alone (the backfill rebuilds it once at the end). The six
--     argument form is the same as p_daily true.

-- MRR without the daily rebuild ------------------------------------------------

create or replace function public.replace_customer_mrr(p_ws uuid, p_source uuid, p_customer text, p_movements jsonb, p_days jsonb, p_feed jsonb, p_daily boolean)
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

  if v_changed is not null and coalesce(p_daily, true) then perform rebuild_mrr_daily(p_ws, v_changed); end if;
  return v_changed;
end;
$fn$;

create or replace function public.replace_customer_mrr(p_ws uuid, p_source uuid, p_customer text, p_movements jsonb, p_days jsonb, p_feed jsonb)
returns date
language sql security definer set search_path = public as $fn$
  select public.replace_customer_mrr(p_ws, p_source, p_customer, p_movements, p_days, p_feed, true)
$fn$;

-- Jobs -------------------------------------------------------------------------

create or replace function public.enqueue_job_once(p_ws uuid, p_kind text, p_key text, p_payload jsonb default '{}')
returns uuid
language plpgsql security definer set search_path = public as $fn$
begin
  if coalesce(p_key, '') = '' then raise exception 'A key is needed'; end if;
  perform pg_advisory_xact_lock(hashtextextended('job_once:' || coalesce(p_ws::text, '') || ':' || p_kind || ':' || p_key, 0));
  if exists (select 1 from jobs where workspace_id is not distinct from p_ws and kind = p_kind and key = p_key) then return null; end if;
  return enqueue_job(p_ws, p_kind, p_key, coalesce(p_payload, '{}'));
end;
$fn$;

-- Connect ----------------------------------------------------------------------

create or replace function public.connect_source(p_ws uuid, p_user uuid, p_kind text, p_account text, p_name text, p_livemode boolean,
  p_access text, p_refresh text, p_api_key text, p_expires_at timestamptz, p_currency text, p_objects text[])
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_id uuid;
  v_empty boolean;
  o text;
begin
  if not exists (select 1 from workspaces where id = p_ws) then raise exception 'Unknown workspace'; end if;
  if p_kind = 'stripe_app' and (p_access is null or p_refresh is null) then raise exception 'A Stripe App source needs its tokens'; end if;
  if p_kind = 'stripe_key' and p_api_key is null then raise exception 'A key source needs its key'; end if;
  perform pg_advisory_xact_lock(hashtextextended('connect_source:' || p_ws::text, 0));
  v_empty := not exists (select 1 from sources where workspace_id = p_ws and account_id <> p_account)
         and not exists (select 1 from mrr_movements where workspace_id = p_ws);

  insert into sources (workspace_id, kind, account_id, account_name, livemode, access_token, refresh_token, api_key, token_expires_at,
                       status, backfill, last_error, connected_by)
  values (p_ws, p_kind, p_account, left(p_name, 200), coalesce(p_livemode, true), p_access, p_refresh, p_api_key, p_expires_at,
          'importing', '{}', null, p_user)
  on conflict (workspace_id, account_id) do update set
    kind = excluded.kind, account_name = coalesce(excluded.account_name, sources.account_name), livemode = excluded.livemode,
    access_token = excluded.access_token, refresh_token = excluded.refresh_token, api_key = excluded.api_key,
    token_expires_at = excluded.token_expires_at, status = 'importing', backfill = '{}', last_error = null,
    connected_by = coalesce(excluded.connected_by, sources.connected_by), updated_at = now()
  returning id into v_id;

  if v_empty and lower(coalesce(p_currency, '')) ~ '^[a-z]{3}$' then
    update workspaces set currency = lower(p_currency) where id = p_ws and currency <> lower(p_currency);
  end if;

  foreach o in array coalesce(p_objects, '{}'::text[]) loop
    perform enqueue_job(p_ws, 'stripe.backfill', v_id::text || ':' || o, jsonb_build_object('source_id', v_id, 'object', o));
  end loop;
  perform enqueue_job(p_ws, 'stripe.poll_events', v_id::text, jsonb_build_object('source_id', v_id));
  return v_id;
end;
$fn$;

-- Events -----------------------------------------------------------------------

create or replace function public.record_stripe_events(p_source uuid, p_events jsonb) returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_ws uuid;
  e record;
  n int := 0;
begin
  select workspace_id into v_ws from sources where id = p_source and status <> 'disconnected';
  if not found then return 0; end if;
  for e in
    select * from jsonb_to_recordset(coalesce(p_events, '[]'::jsonb)) as x(id text, type text, created timestamptz, object_id text,
      customer_id text, changed text[], sync_type text, sync_id text)
  loop
    insert into stripe_events (source_id, workspace_id, id, type, created, object_id, customer_id, changed)
    values (p_source, v_ws, e.id, e.type, e.created, e.object_id, e.customer_id, e.changed)
    on conflict (source_id, id) do nothing;
    if found then
      n := n + 1;
      if e.sync_type is not null and coalesce(e.sync_id, '') <> '' then
        perform enqueue_job(v_ws, 'stripe.sync_object', p_source::text || ':' || e.sync_id,
          jsonb_build_object('source_id', p_source, 'object_type', e.sync_type, 'object_id', e.sync_id));
      end if;
    end if;
  end loop;
  return n;
end;
$fn$;

create or replace function public.record_stripe_event(p_account text, p_livemode boolean, p_event jsonb) returns int
language plpgsql security definer set search_path = public as $fn$
declare
  s record;
  n int := 0;
begin
  for s in select id from sources where account_id = p_account and livemode = coalesce(p_livemode, true) and status <> 'disconnected' order by id loop
    perform record_stripe_events(s.id, jsonb_build_array(p_event));
    n := n + 1;
  end loop;
  return n;
end;
$fn$;

create or replace function public.source_deauthorized(p_account text, p_livemode boolean) returns int
language plpgsql security definer set search_path = public as $fn$
declare
  n int;
begin
  update sources set status = 'disconnected', access_token = null, refresh_token = null, token_expires_at = null,
    last_error = 'Stripe access was removed. Connect Stripe again.', updated_at = now()
  where account_id = p_account and livemode = coalesce(p_livemode, true) and kind = 'stripe_app';
  get diagnostics n = row_count;
  return n;
end;
$fn$;

-- Delete -----------------------------------------------------------------------

create or replace function public.delete_source(p_source uuid) returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_ws uuid;
begin
  delete from sources where id = p_source returning workspace_id into v_ws;
  if v_ws is null then return null; end if;
  delete from jobs where workspace_id = v_ws and status = 'queued' and (key = p_source::text or key like p_source::text || ':%');
  -- From scratch: days before the remaining sources' first movement held this source's history.
  perform pg_advisory_xact_lock(hashtextextended('mrr_daily:' || v_ws::text, 0));
  delete from mrr_daily where workspace_id = v_ws;
  perform rebuild_mrr_daily(v_ws, null);
  return v_ws;
end;
$fn$;

-- Polls ------------------------------------------------------------------------

create or replace function public.due_stripe_polls(p_every_s int default 300) returns int
language plpgsql security definer set search_path = public as $fn$
declare
  s record;
  n int := 0;
begin
  for s in
    select x.id, x.workspace_id from sources x
    where x.status in ('importing', 'live')
      and (x.last_synced_at is null or x.last_synced_at < now() - make_interval(secs => greatest(coalesce(p_every_s, 300), 60)))
      and not exists (select 1 from jobs j where j.workspace_id = x.workspace_id and j.kind = 'stripe.poll_events' and j.key = x.id::text
                      and j.status in ('queued', 'running'))
  loop
    perform enqueue_job(s.workspace_id, 'stripe.poll_events', s.id::text, jsonb_build_object('source_id', s.id));
    n := n + 1;
  end loop;
  return n;
end;
$fn$;

revoke all on function public.replace_customer_mrr(uuid, uuid, text, jsonb, jsonb, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.replace_customer_mrr(uuid, uuid, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.enqueue_job_once(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.connect_source(uuid, uuid, text, text, text, boolean, text, text, text, timestamptz, text, text[]) from public, anon, authenticated;
revoke all on function public.record_stripe_events(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.record_stripe_event(text, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.source_deauthorized(text, boolean) from public, anon, authenticated;
revoke all on function public.delete_source(uuid) from public, anon, authenticated;
revoke all on function public.due_stripe_polls(int) from public, anon, authenticated;
grant execute on function public.replace_customer_mrr(uuid, uuid, text, jsonb, jsonb, jsonb, boolean) to service_role;
grant execute on function public.replace_customer_mrr(uuid, uuid, text, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.enqueue_job_once(uuid, text, text, jsonb) to service_role;
grant execute on function public.connect_source(uuid, uuid, text, text, text, boolean, text, text, text, timestamptz, text, text[]) to service_role;
grant execute on function public.record_stripe_events(uuid, jsonb) to service_role;
grant execute on function public.record_stripe_event(text, boolean, jsonb) to service_role;
grant execute on function public.source_deauthorized(text, boolean) to service_role;
grant execute on function public.delete_source(uuid) to service_role;
grant execute on function public.due_stripe_polls(int) to service_role;
