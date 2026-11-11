-- MRR in the database (009_mrr.sql): replace_customer_mrr swaps one customer's rows and says which day changed,
-- rebuild_mrr_daily over hand-made movements matches totals worked out by hand, a partial rebuild matches a full
-- one, and the read functions give the hand answers. Runs as the server (service_role).
--
-- Three customers in January 2026, in cents:
--   cus_a  Jan 1 new +3000, Jan 10 expansion +2000 (5000), Jan 20 churn -5000
--   cus_b  Jan 5 new +1000, Jan 15 contraction -250 (750)
--   cus_c  Jan 3 new +4000, Jan 12 churn -4000, Jan 25 reactivation +4500
-- MRR by day: Jan 1 3000, Jan 3 7000, Jan 5 8000, Jan 10 10000, Jan 12 6000, Jan 15 5750, Jan 20 750, Jan 25 5250.
\set ON_ERROR_STOP on
set client_min_messages = warning;
\o /dev/null

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'MRR TEST FAILED: %', what; end if;
end $$;
create function pg_temp.err(q text) returns text language plpgsql as $$
begin
  execute q;
  return null;
exception when others then
  return sqlerrm;
end $$;
create function pg_temp.mv(day text, kind text, amount int, before int, after int) returns jsonb language sql as $$
  select jsonb_build_object('day', day, 'at', day || 'T09:00:00Z', 'kind', kind, 'amount', amount, 'mrr_before', before, 'mrr_after', after,
    'currency', 'usd', 'original_amount', amount, 'original_currency', 'usd', 'rate', '1', 'subscription_id', 'sub_x',
    'cause_type', 'invoice', 'cause_id', 'in_' || day)
$$;
create function pg_temp.cd(f text, t text, mrr int) returns jsonb language sql as $$
  select jsonb_build_object('from_day', f, 'to_day', t, 'mrr', mrr, 'mrr_native', mrr, 'native_currency', 'usd', 'rate', '1')
$$;
create function pg_temp.fi(k text, kind text, at text, amount int) returns jsonb language sql as $$
  select jsonb_build_object('key', k, 'kind', kind, 'at', at, 'amount', amount, 'currency', 'usd', 'original_amount', amount,
    'original_currency', 'usd', 'object_type', 'invoice', 'object_id', 'in_' || k)
$$;
create function pg_temp.daily(d text) returns public.mrr_daily language sql as $$
  select * from public.mrr_daily where workspace_id = 'd0000000-0000-0000-0000-000000000001' and day = d::date
$$;
create temp table got (k text primary key, v date);
grant all on got to service_role;

insert into workspaces (id, name) values ('d0000000-0000-0000-0000-000000000001', 'MRR test');
insert into sources (id, workspace_id, kind, account_id, status) values
  ('d1000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'stripe_app', 'acct_mrrtest', 'live');
insert into stripe_customers (source_id, workspace_id, id, name, email, raw) values
  ('d1000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'cus_a', 'Alpha', 'a@alpha.example', '{}'),
  ('d1000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'cus_c', 'Gamma', 'c@gamma.example', '{}');
set role service_role;

-- Replace each customer's rows. The first write of a customer reports its first day as changed.
insert into got values ('a', replace_customer_mrr('d0000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'cus_a',
  jsonb_build_array(pg_temp.mv('2026-01-01', 'new', 3000, 0, 3000), pg_temp.mv('2026-01-10', 'expansion', 2000, 3000, 5000), pg_temp.mv('2026-01-20', 'churn', -5000, 5000, 0)),
  jsonb_build_array(pg_temp.cd('2026-01-01', '2026-01-10', 3000), pg_temp.cd('2026-01-10', '2026-01-20', 5000), pg_temp.cd('2026-01-20', null, 0)),
  jsonb_build_array(pg_temp.fi('signup:cus_a:2026-01-01', 'signup', '2026-01-01T09:00:00Z', 3000), pg_temp.fi('cancel:cus_a:2026-01-20', 'cancel', '2026-01-20T09:00:00Z', -5000))));
insert into got values ('b', replace_customer_mrr('d0000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'cus_b',
  jsonb_build_array(pg_temp.mv('2026-01-05', 'new', 1000, 0, 1000), pg_temp.mv('2026-01-15', 'contraction', -250, 1000, 750)),
  jsonb_build_array(pg_temp.cd('2026-01-05', '2026-01-15', 1000), pg_temp.cd('2026-01-15', null, 750)),
  jsonb_build_array(pg_temp.fi('signup:cus_b:2026-01-05', 'signup', '2026-01-05T09:00:00Z', 1000))));
insert into got values ('c', replace_customer_mrr('d0000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'cus_c',
  jsonb_build_array(pg_temp.mv('2026-01-03', 'new', 4000, 0, 4000), pg_temp.mv('2026-01-12', 'churn', -4000, 4000, 0), pg_temp.mv('2026-01-25', 'reactivation', 4500, 0, 4500)),
  jsonb_build_array(pg_temp.cd('2026-01-03', '2026-01-12', 4000), pg_temp.cd('2026-01-12', '2026-01-25', 0), pg_temp.cd('2026-01-25', null, 4500)),
  jsonb_build_array(pg_temp.fi('signup:cus_c:2026-01-03', 'signup', '2026-01-03T09:00:00Z', 4000))));
select pg_temp.check((select v from got where k = 'a') = '2026-01-01' and (select v from got where k = 'b') = '2026-01-05'
  and (select v from got where k = 'c') = '2026-01-03', 'replace_customer_mrr didn''t report the first day as changed');
select pg_temp.check((select count(*) from mrr_movements) = 8 and (select count(*) from mrr_customer_days) = 8 and (select count(*) from feed_items) = 4,
  'replace_customer_mrr didn''t write every row');

-- Daily totals against the hand totals.
select pg_temp.check((pg_temp.daily('2026-01-01')).mrr = 3000 and (pg_temp.daily('2026-01-01')).active_customers = 1 and (pg_temp.daily('2026-01-01')).new_customers = 1, 'Jan 1');
select pg_temp.check((pg_temp.daily('2026-01-02')).mrr = 3000 and (pg_temp.daily('2026-01-02')).new_mrr = 0, 'Jan 2 (a quiet day still has a row)');
select pg_temp.check((pg_temp.daily('2026-01-03')).mrr = 7000 and (pg_temp.daily('2026-01-03')).active_customers = 2, 'Jan 3');
select pg_temp.check((pg_temp.daily('2026-01-05')).mrr = 8000 and (pg_temp.daily('2026-01-05')).active_customers = 3, 'Jan 5');
select pg_temp.check((pg_temp.daily('2026-01-10')).mrr = 10000 and (pg_temp.daily('2026-01-10')).expansion_mrr = 2000 and (pg_temp.daily('2026-01-10')).arr = 120000, 'Jan 10');
select pg_temp.check((pg_temp.daily('2026-01-12')).mrr = 6000 and (pg_temp.daily('2026-01-12')).churned_mrr = 4000 and (pg_temp.daily('2026-01-12')).churned_customers = 1
  and (pg_temp.daily('2026-01-12')).active_customers = 2 and (pg_temp.daily('2026-01-12')).net_new_mrr = -4000, 'Jan 12');
select pg_temp.check((pg_temp.daily('2026-01-15')).mrr = 5750 and (pg_temp.daily('2026-01-15')).contraction_mrr = 250, 'Jan 15');
select pg_temp.check((pg_temp.daily('2026-01-20')).mrr = 750 and (pg_temp.daily('2026-01-20')).active_customers = 1, 'Jan 20');
select pg_temp.check((pg_temp.daily('2026-01-25')).mrr = 5250 and (pg_temp.daily('2026-01-25')).reactivation_mrr = 4500
  and (pg_temp.daily('2026-01-25')).reactivated_customers = 1 and (pg_temp.daily('2026-01-25')).active_customers = 2, 'Jan 25');
select pg_temp.check((select sum(new_mrr) = 8000 and sum(expansion_mrr) = 2000 and sum(reactivation_mrr) = 4500 and sum(contraction_mrr) = 250
  and sum(churned_mrr) = 9000 and sum(net_new_mrr) = 5250 from mrr_daily where day between '2026-01-01' and '2026-01-31'), 'January''s sums');
-- Every day from the first movement through today, ending at 5250.
select pg_temp.check((select count(*) from mrr_daily) = (now() at time zone 'utc')::date - date '2026-01-01' + 1, 'not one row per day through today');
select pg_temp.check((select mrr from mrr_daily order by day desc limit 1) = 5250 and (select min(day) from mrr_daily) = '2026-01-01', 'the last day isn''t 5250');
select pg_temp.check((select bool_and(mrr = (select coalesce(sum(m.amount), 0) from mrr_movements m where m.day <= d.day)) from mrr_daily d),
  'a day''s MRR isn''t the sum of the movements up to it');

-- A rebuild from the middle matches a full rebuild, and leaves earlier rows alone.
create temp table full_build as select day, mrr, arr, new_mrr, expansion_mrr, reactivation_mrr, contraction_mrr, churned_mrr, net_new_mrr,
  active_customers, new_customers, reactivated_customers, churned_customers, updated_at from mrr_daily;
reset role;
grant all on full_build to service_role;
set role service_role;
select pg_temp.check(rebuild_mrr_daily('d0000000-0000-0000-0000-000000000001', '2026-01-15') = (now() at time zone 'utc')::date - date '2026-01-15' + 1, 'partial rebuild row count');
select pg_temp.check(not exists (
  (select day, mrr, arr, new_mrr, expansion_mrr, reactivation_mrr, contraction_mrr, churned_mrr, net_new_mrr, active_customers, new_customers, reactivated_customers, churned_customers from full_build
   except select day, mrr, arr, new_mrr, expansion_mrr, reactivation_mrr, contraction_mrr, churned_mrr, net_new_mrr, active_customers, new_customers, reactivated_customers, churned_customers from mrr_daily)
  union all
  (select day, mrr, arr, new_mrr, expansion_mrr, reactivation_mrr, contraction_mrr, churned_mrr, net_new_mrr, active_customers, new_customers, reactivated_customers, churned_customers from mrr_daily
   except select day, mrr, arr, new_mrr, expansion_mrr, reactivation_mrr, contraction_mrr, churned_mrr, net_new_mrr, active_customers, new_customers, reactivated_customers, churned_customers from full_build)
), 'a rebuild from Jan 15 differs from a full rebuild');
select pg_temp.check((select d.updated_at from mrr_daily d where d.day = '2026-01-14') = (select f.updated_at from full_build f where f.day = '2026-01-14'), 'a rebuild from Jan 15 rewrote Jan 14');

-- The same rows again change nothing; a moved movement reports the earlier of the two days.
select pg_temp.check(replace_customer_mrr('d0000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'cus_b',
  jsonb_build_array(pg_temp.mv('2026-01-05', 'new', 1000, 0, 1000), pg_temp.mv('2026-01-15', 'contraction', -250, 1000, 750)),
  jsonb_build_array(pg_temp.cd('2026-01-05', '2026-01-15', 1000), pg_temp.cd('2026-01-15', null, 750)),
  jsonb_build_array(pg_temp.fi('signup:cus_b:2026-01-05', 'signup', '2026-01-05T09:00:00Z', 1000))) is null, 'identical rows reported a change');
select pg_temp.check(replace_customer_mrr('d0000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'cus_b',
  jsonb_build_array(pg_temp.mv('2026-01-05', 'new', 1000, 0, 1000), pg_temp.mv('2026-01-17', 'contraction', -250, 1000, 750)),
  jsonb_build_array(pg_temp.cd('2026-01-05', '2026-01-17', 1000), pg_temp.cd('2026-01-17', null, 750)),
  jsonb_build_array(pg_temp.fi('signup:cus_b:2026-01-05', 'signup', '2026-01-05T09:00:00Z', 1000))) = '2026-01-15', 'a moved contraction didn''t report Jan 15');
select pg_temp.check((pg_temp.daily('2026-01-15')).mrr = 6000 and (pg_temp.daily('2026-01-16')).mrr = 6000 and (pg_temp.daily('2026-01-17')).mrr = 5750
  and (pg_temp.daily('2026-01-15')).contraction_mrr = 0, 'the daily totals didn''t follow the moved contraction');
select pg_temp.check((select count(*) from mrr_movements where customer_id = 'cus_b') = 2, 'the old rows stayed');
-- Back to the hand case.
select replace_customer_mrr('d0000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'cus_b',
  jsonb_build_array(pg_temp.mv('2026-01-05', 'new', 1000, 0, 1000), pg_temp.mv('2026-01-15', 'contraction', -250, 1000, 750)),
  jsonb_build_array(pg_temp.cd('2026-01-05', '2026-01-15', 1000), pg_temp.cd('2026-01-15', null, 750)),
  jsonb_build_array(pg_temp.fi('signup:cus_b:2026-01-05', 'signup', '2026-01-05T09:00:00Z', 1000)));

-- Bad rows are refused as a whole, and a source that's gone writes nothing.
select pg_temp.check(pg_temp.err($q$select replace_customer_mrr('d0000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'cus_b',
  jsonb_build_array(pg_temp.mv('2026-01-05', 'new', 1000, 0, 1000), pg_temp.mv('2026-01-15', 'churn', -250, 1000, 750)), '[]', '[]')$q$) like '%violates check constraint%',
  'a churn that doesn''t land on 0 was taken');
select pg_temp.check(pg_temp.err($q$select replace_customer_mrr('d0000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'cus_b',
  jsonb_build_array(pg_temp.mv('2026-01-05', 'expansion', 1000, 0, 1000)), '[]', '[]')$q$) like '%violates check constraint%', 'an expansion from 0 was taken');
select pg_temp.check((select count(*) from mrr_movements where customer_id = 'cus_b') = 2, 'a refused replace still deleted rows');
select pg_temp.check(replace_customer_mrr('d0000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-00000000dead', 'cus_z',
  jsonb_build_array(pg_temp.mv('2026-01-05', 'new', 1000, 0, 1000)), '[]', '[]') is null and not exists (select 1 from mrr_movements where customer_id = 'cus_z'),
  'a missing source took rows');

-- Metrics over a window, against the hand answers.
create function pg_temp.w(m text, f text, t text) returns numeric language sql as $$
  select public.metric_window('d0000000-0000-0000-0000-000000000001', m, f::date, t::date)
$$;
select pg_temp.check(pg_temp.w('mrr', '2026-01-01', '2026-01-31') = 5250, 'mrr');
select pg_temp.check(pg_temp.w('arr', '2026-01-01', '2026-01-31') = 63000, 'arr');
select pg_temp.check(pg_temp.w('net_new_mrr', '2026-01-01', '2026-01-31') = 5250, 'net_new_mrr');
select pg_temp.check(pg_temp.w('new_mrr', '2026-01-01', '2026-01-31') = 8000, 'new_mrr');
select pg_temp.check(pg_temp.w('expansion_mrr', '2026-01-01', '2026-01-31') = 2000, 'expansion_mrr');
select pg_temp.check(pg_temp.w('reactivation_mrr', '2026-01-01', '2026-01-31') = 4500, 'reactivation_mrr');
select pg_temp.check(pg_temp.w('contraction_mrr', '2026-01-01', '2026-01-31') = 250, 'contraction_mrr');
select pg_temp.check(pg_temp.w('churned_mrr', '2026-01-01', '2026-01-31') = 9000, 'churned_mrr');
select pg_temp.check(pg_temp.w('active_customers', '2026-01-01', '2026-01-31') = 2, 'active_customers');
select pg_temp.check(pg_temp.w('new_customers', '2026-01-01', '2026-01-31') = 3, 'new_customers');
select pg_temp.check(pg_temp.w('arpu', '2026-01-01', '2026-01-31') = 2625, 'arpu');
-- Jan 11-31: 3 active at the start (a 5000, b 1000, c 4000 = 10000); a and c churn; b ends at 750, c at 4500.
select pg_temp.check(pg_temp.w('customer_churn_rate', '2026-01-11', '2026-01-31') = 2.0 / 3, 'customer_churn_rate (2 of 3)');
select pg_temp.check(pg_temp.w('revenue_churn_rate', '2026-01-11', '2026-01-31') = 0.925, 'revenue_churn_rate ((9000 + 250) / 10000)');
select pg_temp.check(pg_temp.w('nrr', '2026-01-11', '2026-01-31') = 0.525, 'nrr ((0 + 750 + 4500) / 10000)');
select pg_temp.check(pg_temp.w('grr', '2026-01-11', '2026-01-31') = 0.475, 'grr ((0 + 750 + 4000) / 10000)');
select pg_temp.check(pg_temp.w('quick_ratio', '2026-01-01', '2026-01-31') = 14500.0 / 9250, 'quick_ratio ((8000 + 2000 + 4500) / (250 + 9000))');
-- LTV on Jan 31: ARPU 2625 / (2 churned in Jan 2-31 / 1 active on Jan 1) = 1312.5.
select pg_temp.check(pg_temp.w('ltv', '2026-01-01', '2026-01-31') = 1312.5, 'ltv');
-- Denominators of 0 are null: nobody active before Jan 1.
select pg_temp.check(pg_temp.w('customer_churn_rate', '2026-01-01', '2026-01-31') is null and pg_temp.w('nrr', '2026-01-01', '2026-01-31') is null
  and pg_temp.w('revenue_churn_rate', '2026-01-01', '2026-01-02') is null and pg_temp.w('quick_ratio', '2026-01-01', '2026-01-05') is null, 'a 0 denominator isn''t null');
select pg_temp.check(pg_temp.w('mrr', '2025-12-01', '2025-12-31') = 0, 'before the first movement isn''t 0');
select pg_temp.check(pg_temp.err($q$select metric_window('d0000000-0000-0000-0000-000000000001', 'mrrr', '2026-01-01', '2026-01-31')$q$) = 'Unknown metric', 'an unknown metric was taken');

-- Series.
select pg_temp.check((select array_agg(value order by period) from metric_series('d0000000-0000-0000-0000-000000000001', 'mrr', '2026-01-09', '2026-01-12', 'day'))
  = array[8000, 10000, 10000, 6000]::numeric[], 'daily mrr series');
select pg_temp.check((select array_agg(period::text || '=' || value::text order by period) from metric_series('d0000000-0000-0000-0000-000000000001', 'new_mrr', '2026-01-01', '2026-01-31', 'week'))
  = array['2025-12-29=7000', '2026-01-05=1000', '2026-01-12=0', '2026-01-19=0', '2026-01-26=0'], 'weekly new_mrr series (weeks from Monday, clipped to the range)');
select pg_temp.check((select array_agg(value order by period) from metric_series('d0000000-0000-0000-0000-000000000001', 'churned_mrr', '2025-12-01', '2026-02-28', 'month'))
  = array[0, 9000, 0]::numeric[], 'monthly churned series');
select pg_temp.check((select count(*) from metric_series('d0000000-0000-0000-0000-000000000001', 'mrr', '2026-01-01', '2026-12-31', 'quarter')) = 4, 'quarters');
select pg_temp.check(pg_temp.err($q$select * from metric_series('d0000000-0000-0000-0000-000000000001', 'mrr', '2000-01-01', '2026-01-31', 'day')$q$) = 'Pick a shorter range', 'a 26-year daily series was taken');
select pg_temp.check(pg_temp.err($q$select * from metric_series('d0000000-0000-0000-0000-000000000001', 'mrr', '2026-01-01', '2026-01-31', 'hour')$q$) like 'Pick day%', 'an hourly series was taken');

-- Summary: Jan 16-31 against Dec 31-Jan 15.
select pg_temp.check((select value = 5250 and previous = 5750 and change = -500 and change_pct = -500.0 / 5750 from metric_summary('d0000000-0000-0000-0000-000000000001', '2026-01-16', '2026-01-31') where metric = 'mrr'),
  'summary mrr');
select pg_temp.check((select count(*) from metric_summary('d0000000-0000-0000-0000-000000000001', '2026-01-16', '2026-01-31')) = 17, 'summary has every metric');
select pg_temp.check((select value = 5000 and previous = 4000 from metric_summary('d0000000-0000-0000-0000-000000000001', '2026-01-16', '2026-01-31') where metric = 'churned_mrr'), 'summary churned');

-- The customers behind a metric, newest first, with their names.
select pg_temp.check((select array_agg(customer_id || ':' || coalesce(customer_name, '-') order by day desc) from metric_movements('d0000000-0000-0000-0000-000000000001', 'churned_mrr', '2026-01-01', '2026-01-31'))
  = array['cus_a:Alpha', 'cus_c:Gamma'], 'metric_movements for churn');
select pg_temp.check((select count(*) from metric_movements('d0000000-0000-0000-0000-000000000001', 'mrr', '2026-01-01', '2026-01-31')) = 8, 'metric_movements for mrr');
select pg_temp.check((select count(*) from metric_movements('d0000000-0000-0000-0000-000000000001', 'nrr', '2026-01-01', '2026-01-31')) = 4, 'metric_movements for nrr');

-- The feed, newest first, paged by time.
select pg_temp.check((select array_agg(kind || ':' || customer_id) from feed('d0000000-0000-0000-0000-000000000001', null, 50))
  = array['cancel:cus_a', 'signup:cus_b', 'signup:cus_c', 'signup:cus_a'], 'feed order');
select pg_temp.check((select array_agg(customer_id) from feed('d0000000-0000-0000-0000-000000000001', '2026-01-05T09:00:00Z', 1)) = array['cus_c'], 'feed paging');
select pg_temp.check((select count(*) from feed('d0000000-0000-0000-0000-000000000001', null, 0)) = 1, 'a feed limit below 1 isn''t 1');

-- A workspace with no movements left has no daily rows.
reset role;
delete from mrr_movements;
set role service_role;
select pg_temp.check(rebuild_mrr_daily('d0000000-0000-0000-0000-000000000001') = 0, 'a rebuild with no movements wrote rows');
select pg_temp.check(not exists (select 1 from mrr_daily), 'daily rows outlived their movements');
reset role;

-- Deleting the source takes every row it brought in.
delete from sources where id = 'd1000000-0000-0000-0000-000000000001';
select pg_temp.check(not exists (select 1 from mrr_customer_days) and not exists (select 1 from feed_items) and not exists (select 1 from stripe_customers),
  'rows outlived their source');

\o
select 'mrr tests passed' as result;
