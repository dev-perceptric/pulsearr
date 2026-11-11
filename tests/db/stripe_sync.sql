-- Connecting, syncing and removing sources (010_stripe_sync.sql). Runs as the server (service_role).
--   connect_source: the source row, sealed values only, the workspace currency only while it has no data, one
--     backfill job per object and a first poll; connecting again updates the same row and doesn't add jobs twice.
--   record_stripe_events / record_stripe_event: the same event twice is stored once and enqueues one sync; an
--     unknown account stores nothing; a disconnected source stores nothing; both sources of one account get it.
--   source_deauthorized wipes the tokens. delete_source removes the rows, the waiting jobs, and rebuilds mrr_daily.
--   replace_customer_mrr(..., false) leaves mrr_daily alone. enqueue_job_once. due_stripe_polls. Grants.
\set ON_ERROR_STOP on
set client_min_messages = warning;
\o /dev/null

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'STRIPE SYNC TEST FAILED: %', what; end if;
end $$;
create function pg_temp.err(q text) returns text language plpgsql as $$
begin
  execute q;
  return null;
exception when others then
  return sqlerrm;
end $$;
create function pg_temp.ev(id text, obj text, typ text default 'customer.subscription.updated') returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'type', typ, 'created', '2026-03-01T10:00:00Z', 'object_id', obj, 'customer_id', 'cus_a',
    'changed', jsonb_build_array('items', 'status'), 'sync_type', 'subscription', 'sync_id', obj)
$$;
create temp table got (k text primary key, v text);
grant all on got to service_role;

insert into auth.users (id, email) values ('a0000000-0000-0000-0000-000000000001', 'ann@acme.com');
insert into workspaces (id, name) values
  ('e0000000-0000-0000-0000-000000000001', 'Acme'),
  ('e0000000-0000-0000-0000-000000000002', 'Other');
insert into workspace_members (workspace_id, user_id, role, email) values
  ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'owner', 'ann@acme.com');

-- Grants: only the server runs these.
select pg_temp.check(not has_function_privilege('authenticated', 'public.connect_source(uuid, uuid, text, text, text, boolean, text, text, text, timestamptz, text, text[])', 'execute')
  and not has_function_privilege('authenticated', 'public.record_stripe_events(uuid, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.record_stripe_event(text, boolean, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.delete_source(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.source_deauthorized(text, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.enqueue_job_once(uuid, text, text, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.due_stripe_polls(int)', 'execute')
  and not has_function_privilege('authenticated', 'public.replace_customer_mrr(uuid, uuid, text, jsonb, jsonb, jsonb, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.connect_source(uuid, uuid, text, text, text, boolean, text, text, text, timestamptz, text, text[])', 'execute')
  and has_function_privilege('service_role', 'public.connect_source(uuid, uuid, text, text, text, boolean, text, text, text, timestamptz, text, text[])', 'execute')
  and has_function_privilege('service_role', 'public.record_stripe_event(text, boolean, jsonb)', 'execute'), 'function grants');

set role service_role;

-- Connect -----------------------------------------------------------------------
insert into got values ('src', connect_source('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'stripe_app', 'acct_one',
  'One Inc', true, 'v1:access', 'v1:refresh', null, now() + interval '1 hour', 'EUR', array['products', 'customers', 'invoices']));
select pg_temp.check((select count(*) = 1 from sources where account_id = 'acct_one' and status = 'importing' and kind = 'stripe_app'
  and access_token = 'v1:access' and connected_by = 'a0000000-0000-0000-0000-000000000001'), 'source saved, importing');
select pg_temp.check((select currency = 'eur' from workspaces where id = 'e0000000-0000-0000-0000-000000000001'), 'currency from the account while there is no data');
select pg_temp.check((select count(*) = 3 from jobs where kind = 'stripe.backfill' and status = 'queued'
  and key in (select v || ':products' from got where k = 'src' union all select v || ':customers' from got where k = 'src' union all select v || ':invoices' from got where k = 'src')),
  'one backfill job per object');
select pg_temp.check((select payload->>'object' = 'customers' and payload->>'source_id' = (select v from got where k = 'src')
  from jobs where kind = 'stripe.backfill' and key like '%:customers'), 'backfill payload');
select pg_temp.check((select count(*) = 1 from jobs where kind = 'stripe.poll_events' and key = (select v from got where k = 'src')), 'a first poll');
select pg_temp.check(pg_temp.err($q$select connect_source('e0000000-0000-0000-0000-000000000001', null, 'stripe_app', 'acct_two', null, true, 'plain-token', 'v1:x', null, null, null, '{}')$q$)
  is not null, 'unsealed tokens are refused');
select pg_temp.check(pg_temp.err($q$select connect_source('e0000000-0000-0000-0000-000000000001', null, 'stripe_app', 'acct_two', null, true, null, null, null, null, null, '{}')$q$)
  is not null, 'an app source needs tokens');

-- Connecting again: same row, new tokens, progress cleared, jobs not doubled.
update sources set backfill = '{"customers": {"done": true}}', status = 'live' where account_id = 'acct_one';
select connect_source('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'stripe_app', 'acct_one',
  null, true, 'v1:access2', 'v1:refresh2', null, now() + interval '1 hour', 'usd', array['products', 'customers', 'invoices']);
select pg_temp.check((select count(*) = 1 from sources where account_id = 'acct_one'), 'one row per account');
select pg_temp.check((select access_token = 'v1:access2' and refresh_token = 'v1:refresh2' and backfill = '{}' and status = 'importing'
  and account_name = 'One Inc' from sources where account_id = 'acct_one'), 'reconnect updates the row and keeps the name');
select pg_temp.check((select count(*) = 3 from jobs where kind = 'stripe.backfill' and status = 'queued'), 'waiting jobs are joined, not doubled');
select pg_temp.check((select currency = 'usd' from workspaces where id = 'e0000000-0000-0000-0000-000000000001'), 'still no data: the account''s currency again');

-- A second account in the same workspace once it has data: the currency stays.
insert into mrr_movements (workspace_id, source_id, customer_id, day, at, kind, amount, mrr_before, mrr_after, currency, original_amount, original_currency, rate, cause_type, cause_id)
select 'e0000000-0000-0000-0000-000000000001', id, 'cus_a', '2026-01-01', '2026-01-01T00:00:00Z', 'new', 3000, 0, 3000, 'eur', 3000, 'eur', 1, 'invoice', 'in_1'
from sources where account_id = 'acct_one';
select rebuild_mrr_daily('e0000000-0000-0000-0000-000000000001');
insert into got values ('key', connect_source('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'stripe_key', 'acct_key',
  'Key Inc', false, null, null, 'v1:key', null, 'gbp', array['customers']));
select pg_temp.check((select currency = 'usd' from workspaces where id = 'e0000000-0000-0000-0000-000000000001'), 'currency kept once there is data');
select pg_temp.check((select api_key = 'v1:key' and not livemode from sources where account_id = 'acct_key'), 'key source saved');

-- The same account in another workspace.
insert into got values ('other', connect_source('e0000000-0000-0000-0000-000000000002', null, 'stripe_app', 'acct_one',
  'One Inc', true, 'v1:a', 'v1:r', null, null, 'usd', '{}'));

-- Events ------------------------------------------------------------------------
insert into got values ('n1', record_stripe_event('acct_one', true, pg_temp.ev('evt_1', 'sub_1')));
insert into got values ('n2', record_stripe_event('acct_one', true, pg_temp.ev('evt_1', 'sub_1')));
select pg_temp.check((select v = '2' from got where k = 'n1') and (select v = '2' from got where k = 'n2'), 'both sources of the account know it');
select pg_temp.check((select count(*) = 1 from stripe_events where id = 'evt_1' and source_id = (select v::uuid from got where k = 'src')), 'the same event twice is stored once');
select pg_temp.check((select count(*) = 2 from stripe_events where id = 'evt_1'), 'once per source');
select pg_temp.check((select changed = array['items', 'status'] and customer_id = 'cus_a' and object_id = 'sub_1' and type = 'customer.subscription.updated'
  from stripe_events where id = 'evt_1' and source_id = (select v::uuid from got where k = 'src')), 'event fields');
select pg_temp.check((select count(*) = 1 from jobs where kind = 'stripe.sync_object' and key = (select v from got where k = 'src') || ':sub_1'), 'one sync job for the object');
select pg_temp.check((select payload = jsonb_build_object('source_id', (select v from got where k = 'src'), 'object_type', 'subscription', 'object_id', 'sub_1')
  from jobs where kind = 'stripe.sync_object' and key = (select v from got where k = 'src') || ':sub_1'), 'sync payload');
-- Another event for the same object while the sync waits: stored, and joins the waiting job.
select record_stripe_event('acct_one', true, pg_temp.ev('evt_2', 'sub_1'));
select pg_temp.check((select count(*) = 1 from jobs where kind = 'stripe.sync_object' and status = 'queued' and key = (select v from got where k = 'src') || ':sub_1'), 'a burst is one job');
select pg_temp.check((select count(*) = 2 from stripe_events where source_id = (select v::uuid from got where k = 'src')), 'both events kept');
-- Unknown account, wrong mode, an event we don't sync.
select pg_temp.check(record_stripe_event('acct_nobody', true, pg_temp.ev('evt_3', 'sub_9')) = 0, 'unknown account: nothing');
select pg_temp.check(record_stripe_event('acct_one', false, pg_temp.ev('evt_4', 'sub_9')) = 0, 'test mode event for a live source: nothing');
select pg_temp.check((select count(*) = 0 from stripe_events where id in ('evt_3', 'evt_4')), 'nothing stored for them');
select record_stripe_events((select v::uuid from got where k = 'src'),
  jsonb_build_array(pg_temp.ev('evt_5', 'pi_1', 'payment_intent.created') - 'sync_type' - 'sync_id'));
select pg_temp.check((select count(*) = 1 from stripe_events where id = 'evt_5') and (select count(*) = 0 from jobs where key like '%:pi_1'), 'stored, no sync for objects we don''t keep');

-- Deauthorized ------------------------------------------------------------------
select pg_temp.check(source_deauthorized('acct_one', true) = 2, 'both app sources of the account');
select pg_temp.check((select bool_and(status = 'disconnected' and access_token is null and refresh_token is null) from sources where account_id = 'acct_one'), 'tokens wiped');
select pg_temp.check(record_stripe_event('acct_one', true, pg_temp.ev('evt_6', 'sub_1')) = 0, 'a disconnected source stores nothing');

-- MRR without the daily rebuild -------------------------------------------------
update sources set status = 'live' where account_id = 'acct_key';
insert into got values ('daily_before', (select count(*)::text from mrr_daily where workspace_id = 'e0000000-0000-0000-0000-000000000001'));
select replace_customer_mrr('e0000000-0000-0000-0000-000000000001', (select v::uuid from got where k = 'key'), 'cus_k',
  jsonb_build_array(jsonb_build_object('day', '2025-12-01', 'at', '2025-12-01T09:00:00Z', 'kind', 'new', 'amount', 1000, 'mrr_before', 0, 'mrr_after', 1000,
    'currency', 'eur', 'original_amount', 1000, 'original_currency', 'eur', 'rate', '1', 'subscription_id', 'sub_k', 'cause_type', 'invoice', 'cause_id', 'in_k')),
  '[]', '[]', false);
select pg_temp.check((select count(*) = 1 from mrr_movements where customer_id = 'cus_k'), 'movements written');
select pg_temp.check((select count(*)::text from mrr_daily where workspace_id = 'e0000000-0000-0000-0000-000000000001') = (select v from got where k = 'daily_before')
  and not exists (select 1 from mrr_daily where workspace_id = 'e0000000-0000-0000-0000-000000000001' and day = '2025-12-01'), 'mrr_daily left alone');
select rebuild_mrr_daily('e0000000-0000-0000-0000-000000000001', null);
select pg_temp.check((select mrr = 4000 from mrr_daily where workspace_id = 'e0000000-0000-0000-0000-000000000001' and day = '2026-01-01'), 'one rebuild counts both');

-- Delete ------------------------------------------------------------------------
insert into stripe_customers (source_id, workspace_id, id, raw) values ((select v::uuid from got where k = 'src'), 'e0000000-0000-0000-0000-000000000001', 'cus_a', '{}');
select pg_temp.check(delete_source((select v::uuid from got where k = 'src')) = 'e0000000-0000-0000-0000-000000000001', 'delete answers the workspace');
select pg_temp.check((select count(*) = 0 from stripe_customers where source_id = (select v::uuid from got where k = 'src'))
  and (select count(*) = 0 from stripe_events where source_id = (select v::uuid from got where k = 'src'))
  and (select count(*) = 0 from mrr_movements where customer_id = 'cus_a'), 'its rows went with it');
select pg_temp.check((select count(*) = 0 from jobs where status = 'queued' and key like (select v from got where k = 'src') || '%'), 'its waiting jobs went too');
select pg_temp.check((select count(*) > 0 from jobs where status = 'queued' and key like (select v from got where k = 'key') || '%'), 'other sources keep theirs');
select pg_temp.check((select mrr = 1000 from mrr_daily where workspace_id = 'e0000000-0000-0000-0000-000000000001' and day = '2026-01-01')
  and (select min(day) = '2025-12-01' from mrr_daily where workspace_id = 'e0000000-0000-0000-0000-000000000001'), 'mrr_daily rebuilt without it');
select pg_temp.check(delete_source((select v::uuid from got where k = 'src')) is null, 'deleting twice is fine');
select pg_temp.check((select count(*) = 1 from sources where workspace_id = 'e0000000-0000-0000-0000-000000000002'), 'the other workspace keeps its source');
select delete_source((select v::uuid from got where k = 'key'));
select pg_temp.check((select count(*) = 0 from mrr_daily where workspace_id = 'e0000000-0000-0000-0000-000000000001'), 'no sources: no daily rows');

-- Jobs once, polls --------------------------------------------------------------
select pg_temp.check(enqueue_job_once(null, 'fx.load', '2026-11-11', '{}') is not null, 'first daily job');
select pg_temp.check(enqueue_job_once(null, 'fx.load', '2026-11-11', '{}') is null, 'second is skipped');
update jobs set status = 'done' where kind = 'fx.load';
select pg_temp.check(enqueue_job_once(null, 'fx.load', '2026-11-11', '{}') is null, 'still skipped after it ran');
select pg_temp.check(enqueue_job_once(null, 'fx.load', '2026-11-12', '{}') is not null, 'the next day runs');

update sources set status = 'live', last_synced_at = null where workspace_id = 'e0000000-0000-0000-0000-000000000002';
delete from jobs where kind = 'stripe.poll_events';
select pg_temp.check(due_stripe_polls(300) = 1, 'a live source never synced is due');
select pg_temp.check(due_stripe_polls(300) = 0, 'not twice while one waits');
delete from jobs where kind = 'stripe.poll_events';
update sources set last_synced_at = now() where workspace_id = 'e0000000-0000-0000-0000-000000000002';
select pg_temp.check(due_stripe_polls(300) = 0, 'synced a moment ago: not due');
update sources set last_synced_at = now() - interval '6 minutes' where workspace_id = 'e0000000-0000-0000-0000-000000000002';
select pg_temp.check(due_stripe_polls(300) = 1, 'due after 5 minutes');

reset role;
\o
select 'stripe sync ok';
