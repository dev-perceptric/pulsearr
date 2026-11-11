-- Leak tests for the Stripe and MRR tables (008_stripe.sql, 009_mrr.sql). Ann owns Acme; Cat owns Other. Each
-- workspace has one source and one row in every table. Ann reads only Acme's rows, never a sealed token, writes
-- nothing, can't run the server's functions, and the read functions give her nothing for Other. anon gets nothing.
-- Deleting a source deletes its rows; deleting a workspace deletes its sources.
\set ON_ERROR_STOP on
set client_min_messages = warning;
\o /dev/null

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'STRIPE LEAK TEST FAILED: %', what; end if;
end $$;
create function pg_temp.as_user(uid text, email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when coalesce(uid, '') = '' then '' else json_build_object('sub', uid, 'email', email, 'role', 'authenticated')::text end, false);
end $$;
create function pg_temp.err(q text) returns text language plpgsql as $$
begin
  execute q;
  return null;
exception when others then
  return sqlerrm;
end $$;
create function pg_temp.count(t text, cond text default 'true') returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from public.%I where %s', t, cond) into n;
  return n;
end $$;

insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'ann@acme.com'),
  ('c0000000-0000-0000-0000-000000000001', 'cat@other.com');
insert into workspaces (id, name) values
  ('11111111-0000-0000-0000-000000000001', 'Acme'),
  ('22222222-0000-0000-0000-000000000001', 'Other');
insert into workspace_members (workspace_id, user_id, role, email) values
  ('11111111-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'owner', 'ann@acme.com'),
  ('22222222-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'owner', 'cat@other.com');

-- One source, and one row in every table, for each workspace.
create function pg_temp.fill(ws uuid, src uuid, acct text) returns void language plpgsql as $$
begin
  insert into sources (id, workspace_id, kind, account_id, account_name, access_token, refresh_token, status)
  values (src, ws, 'stripe_app', acct, acct || ' Inc', 'v1:sealed-access-' || acct, 'v1:sealed-refresh-' || acct, 'live');
  insert into stripe_events (source_id, workspace_id, id, type, created, object_id, customer_id, changed)
  values (src, ws, 'evt_' || acct, 'customer.subscription.updated', now(), 'sub_' || acct, 'cus_' || acct, array['items']);
  insert into stripe_customers (source_id, workspace_id, id, email, name, raw) values (src, ws, 'cus_' || acct, acct || '@example.com', acct, '{"secret":"x"}');
  insert into stripe_products (source_id, workspace_id, id, name, raw) values (src, ws, 'prod_' || acct, 'Pro', '{}');
  insert into stripe_prices (source_id, workspace_id, id, product_id, currency, type, unit_amount, interval, interval_count, usage_type, raw)
  values (src, ws, 'price_' || acct, 'prod_' || acct, 'usd', 'recurring', 3000, 'month', 1, 'licensed', '{}');
  insert into stripe_coupons (source_id, workspace_id, id, percent_off, duration, raw) values (src, ws, 'co_' || acct, 50, 'forever', '{}');
  insert into stripe_subscriptions (source_id, workspace_id, id, customer_id, status, raw) values (src, ws, 'sub_' || acct, 'cus_' || acct, 'active', '{}');
  insert into stripe_subscription_items (source_id, workspace_id, id, subscription_id, price_id, quantity, raw) values (src, ws, 'si_' || acct, 'sub_' || acct, 'price_' || acct, 1, '{}');
  insert into stripe_invoices (source_id, workspace_id, id, customer_id, subscription_id, status, amount_due, raw) values (src, ws, 'in_' || acct, 'cus_' || acct, 'sub_' || acct, 'paid', 3000, '{}');
  insert into stripe_invoice_lines (source_id, workspace_id, invoice_id, id, customer_id, subscription_id, amount, raw) values (src, ws, 'in_' || acct, 'il_' || acct, 'cus_' || acct, 'sub_' || acct, 3000, '{}');
  insert into stripe_charges (source_id, workspace_id, id, customer_id, invoice_id, status, amount, raw) values (src, ws, 'ch_' || acct, 'cus_' || acct, 'in_' || acct, 'succeeded', 3000, '{}');
  insert into stripe_refunds (source_id, workspace_id, id, charge_id, customer_id, amount, status, raw) values (src, ws, 're_' || acct, 'ch_' || acct, 'cus_' || acct, 3000, 'succeeded', '{}');
  insert into mrr_movements (workspace_id, source_id, customer_id, day, at, kind, amount, mrr_before, mrr_after, currency, original_amount, original_currency, rate, cause_type, cause_id)
  values (ws, src, 'cus_' || acct, '2026-01-01', '2026-01-01T00:00:00Z', 'new', 3000, 0, 3000, 'usd', 3000, 'usd', 1, 'invoice', 'in_' || acct);
  insert into mrr_customer_days (workspace_id, source_id, customer_id, from_day, mrr, mrr_native, native_currency, rate) values (ws, src, 'cus_' || acct, '2026-01-01', 3000, 3000, 'usd', 1);
  insert into feed_items (workspace_id, source_id, customer_id, key, kind, at, amount, currency, original_amount, original_currency, object_type, object_id)
  values (ws, src, 'cus_' || acct, 'signup:cus_' || acct || ':2026-01-01', 'signup', '2026-01-01T00:00:00Z', 3000, 'usd', 3000, 'usd', 'invoice', 'in_' || acct);
  perform rebuild_mrr_daily(ws);
end $$;
select pg_temp.fill('11111111-0000-0000-0000-000000000001', '1a1a1a1a-0000-0000-0000-000000000001', 'acct_acme');
select pg_temp.fill('22222222-0000-0000-0000-000000000001', '2b2b2b2b-0000-0000-0000-000000000001', 'acct_other');
insert into fx_rates (base, quote, day, rate) values ('eur', 'usd', '2026-01-02', 1.0870);

create temp table workspace_tables (name text primary key);
insert into workspace_tables values ('sources'), ('stripe_events'), ('stripe_customers'), ('stripe_products'), ('stripe_prices'), ('stripe_coupons'),
  ('stripe_subscriptions'), ('stripe_subscription_items'), ('stripe_invoices'), ('stripe_invoice_lines'), ('stripe_charges'), ('stripe_refunds'),
  ('mrr_movements'), ('mrr_customer_days'), ('mrr_daily'), ('feed_items');
grant select on workspace_tables to authenticated, anon;
select pg_temp.check((select count(*) from workspace_tables t where pg_temp.count(t.name, 'workspace_id = ''22222222-0000-0000-0000-000000000001''') = 0) = 0, 'a table has no row for Other');

-- No API role may use a sequence in public (identity columns are the server's).
select pg_temp.check(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace, unnest(array['anon', 'authenticated']) r(role)
  where n.nspname = 'public' and c.relkind = 'S' and (has_sequence_privilege(r.role, c.oid, 'usage') or has_sequence_privilege(r.role, c.oid, 'select') or has_sequence_privilege(r.role, c.oid, 'update'))
), 'anon or authenticated can use a sequence');
-- The server's functions are the server's alone.
select pg_temp.check(not has_function_privilege('authenticated', 'public.rebuild_mrr_daily(uuid, date)', 'execute')
  and not has_function_privilege('authenticated', 'public.replace_customer_mrr(uuid, uuid, text, jsonb, jsonb, jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.rebuild_mrr_daily(uuid, date)', 'execute')
  and has_function_privilege('service_role', 'public.replace_customer_mrr(uuid, uuid, text, jsonb, jsonb, jsonb)', 'execute'), 'the MRR write functions are open to signed-in people');
-- The sealed columns are the server's alone.
select pg_temp.check(not has_column_privilege('authenticated', 'public.sources', 'access_token', 'select')
  and not has_column_privilege('authenticated', 'public.sources', 'refresh_token', 'select')
  and not has_column_privilege('authenticated', 'public.sources', 'api_key', 'select')
  and has_column_privilege('authenticated', 'public.sources', 'status', 'select'), 'sealed source columns are readable');
select pg_temp.check(pg_temp.err($q$insert into sources (workspace_id, kind, account_id, access_token) values ('11111111-0000-0000-0000-000000000001', 'stripe_app', 'acct_plain', 'sk_live_plain')$q$) like '%check constraint%',
  'an unsealed token was stored');
-- A row can't sit under another workspace's source.
select pg_temp.check(pg_temp.err($q$insert into stripe_customers (source_id, workspace_id, id, raw) values ('2b2b2b2b-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'cus_mixed', '{}')$q$) like '%foreign key%',
  'a row was stored under another workspace''s source');

-- Ann (owner of Acme) ----------------------------------------------------------------------------------------
select pg_temp.as_user('a0000000-0000-0000-0000-000000000001', 'ann@acme.com');
set role authenticated;
select pg_temp.check((select count(*) from workspace_tables t where pg_temp.count(t.name, 'workspace_id <> ''11111111-0000-0000-0000-000000000001''') > 0) = 0, 'Ann sees Other''s rows');
select pg_temp.check((select count(*) from workspace_tables t where pg_temp.count(t.name) = 0) = 0, 'Ann doesn''t see her own rows');
select pg_temp.check((select count(*) from fx_rates) = 1, 'Ann can''t read the currency rates');
select pg_temp.check((select account_name from sources) = 'acct_acme Inc', 'Ann can''t read her source');
select pg_temp.check(pg_temp.err('select access_token from sources') like 'permission denied%', 'Ann read a sealed access token');
select pg_temp.check(pg_temp.err('select refresh_token from sources') like 'permission denied%', 'Ann read a sealed refresh token');
select pg_temp.check(pg_temp.err('select api_key from sources') like 'permission denied%', 'Ann read a sealed key');
select pg_temp.check(pg_temp.err('select * from sources') like 'permission denied%', 'select * on sources includes the sealed columns');
-- No writes, to her own rows or anyone's.
select pg_temp.check((select count(*) from workspace_tables t
  where pg_temp.err(format('delete from public.%I', t.name)) not like 'permission denied%'
     or pg_temp.err(format('update public.%I set workspace_id = workspace_id', t.name)) not like 'permission denied%') = 0, 'Ann wrote a table directly');
select pg_temp.check(pg_temp.err($q$insert into mrr_movements (workspace_id, source_id, customer_id, day, at, kind, amount, mrr_before, mrr_after, currency, original_amount, original_currency, rate, cause_type, cause_id)
  values ('11111111-0000-0000-0000-000000000001', '1a1a1a1a-0000-0000-0000-000000000001', 'cus_fake', '2026-01-01', now(), 'new', 1, 0, 1, 'usd', 1, 'usd', 1, 'invoice', 'x')$q$) like 'permission denied%', 'Ann added a movement');
select pg_temp.check(pg_temp.err($q$insert into fx_rates (base, quote, day, rate) values ('usd', 'gbp', '2026-01-02', 0.8)$q$) like 'permission denied%', 'Ann added a rate');
select pg_temp.check(pg_temp.err($q$select rebuild_mrr_daily('22222222-0000-0000-0000-000000000001')$q$) like 'permission denied%', 'Ann rebuilt daily totals');
select pg_temp.check(pg_temp.err($q$select replace_customer_mrr('22222222-0000-0000-0000-000000000001', '2b2b2b2b-0000-0000-0000-000000000001', 'cus_acct_other', '[]', '[]', '[]')$q$) like 'permission denied%', 'Ann replaced a customer''s MRR');
-- The read functions: her own workspace answers, Other gives nothing.
select pg_temp.check(metric_window('11111111-0000-0000-0000-000000000001', 'mrr', '2026-01-01', '2026-01-31') = 3000, 'Ann can''t read her own MRR');
select pg_temp.check(metric_window('22222222-0000-0000-0000-000000000001', 'mrr', '2026-01-01', '2026-01-31') is null, 'metric_window answered for Other');
select pg_temp.check((select count(*) from metric_series('22222222-0000-0000-0000-000000000001', 'mrr', '2026-01-01', '2026-01-31', 'day')) = 0, 'metric_series answered for Other');
select pg_temp.check((select count(*) from metric_summary('22222222-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31')) = 0, 'metric_summary answered for Other');
select pg_temp.check((select count(*) from metric_movements('22222222-0000-0000-0000-000000000001', 'mrr', '2026-01-01', '2026-01-31')) = 0, 'metric_movements answered for Other');
select pg_temp.check((select count(*) from feed('22222222-0000-0000-0000-000000000001')) = 0, 'feed answered for Other');
select pg_temp.check((select count(*) from metric_movements('11111111-0000-0000-0000-000000000001', 'mrr', '2026-01-01', '2026-01-31')) = 1
  and (select count(*) from feed('11111111-0000-0000-0000-000000000001')) = 1, 'Ann can''t read her own movements and feed');
reset role;

-- anon -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('', '');
set role anon;
select pg_temp.check((select count(*) from workspace_tables t where pg_temp.err(format('select 1 from public.%I', t.name)) not like 'permission denied%') = 0, 'anon reads a table');
select pg_temp.check(pg_temp.err('select 1 from fx_rates') like 'permission denied%', 'anon reads the rates');
select pg_temp.check(pg_temp.err($q$select metric_window('11111111-0000-0000-0000-000000000001', 'mrr', '2026-01-01', '2026-01-31')$q$) like 'permission denied%', 'anon runs metric_window');
select pg_temp.check(pg_temp.err($q$select * from feed('11111111-0000-0000-0000-000000000001')$q$) like 'permission denied%', 'anon runs feed');
reset role;
-- Signed out with the authenticated role: nothing.
set role authenticated;
select pg_temp.check((select count(*) from workspace_tables t where pg_temp.count(t.name) > 0) = 0, 'no sign-in still sees rows');
select pg_temp.check(metric_window('11111111-0000-0000-0000-000000000001', 'mrr', '2026-01-01', '2026-01-31') is null, 'no sign-in reads MRR');
reset role;

-- Disconnecting a source removes its rows; mrr_daily goes with the workspace.
delete from sources where id = '2b2b2b2b-0000-0000-0000-000000000001';
select pg_temp.check((select count(*) from workspace_tables t where t.name <> 'mrr_daily' and pg_temp.count(t.name, 'workspace_id = ''22222222-0000-0000-0000-000000000001''') > 0) = 0, 'rows outlived their source');
select pg_temp.check((select count(*) from workspace_tables t where pg_temp.count(t.name, 'workspace_id = ''11111111-0000-0000-0000-000000000001''') = 0) = 0, 'disconnecting Other touched Acme');
delete from workspaces where id = '11111111-0000-0000-0000-000000000001';
select pg_temp.check((select count(*) from workspace_tables t where pg_temp.count(t.name, 'workspace_id = ''11111111-0000-0000-0000-000000000001''') > 0) = 0, 'rows outlived their workspace');

\o
select 'stripe leak tests passed' as result;
