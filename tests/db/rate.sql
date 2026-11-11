-- Rate limits (005_rate_limits.sql): a fixed window per bucket, a limit per window, buckets kept apart, old
-- windows cleared.
\set ON_ERROR_STOP on
set client_min_messages = warning;
\o /dev/null

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'RATE TEST FAILED: %', what; end if;
end $$;
create function pg_temp.err(q text) returns text language plpgsql as $$
begin
  execute q;
  return null;
exception when others then
  return sqlerrm;
end $$;

-- One transaction, so now() can't cross a window or day boundary between checks.
begin;
set role service_role;
-- Three uses an hour: the fourth is refused and not counted.
select pg_temp.check(take_rate('waitlist:ip1', 3, 3600), 'use 1 was refused');
select pg_temp.check(take_rate('waitlist:ip1', 3, 3600), 'use 2 was refused');
select pg_temp.check(take_rate('waitlist:ip1', 3, 3600), 'use 3 was refused');
select pg_temp.check(not take_rate('waitlist:ip1', 3, 3600), 'use 4 went over the limit');
select pg_temp.check(not take_rate('waitlist:ip1', 3, 3600), 'use 5 went over the limit');
select pg_temp.check((select used from rate_buckets where bucket = 'waitlist:ip1') = 3, 'refused uses were counted');
-- Another bucket has its own count.
select pg_temp.check(take_rate('waitlist:ip2', 3, 3600), 'another bucket was refused');
-- The window lines up with the clock: an hour window starts on the hour.
select pg_temp.check((select window_start = date_trunc('hour', now()) from rate_buckets where bucket = 'waitlist:ip1'), 'an hour window doesn''t start on the hour');
-- A new window starts fresh and clears the bucket's old window.
update rate_buckets set window_start = window_start - interval '1 hour' where bucket = 'waitlist:ip1';
select pg_temp.check(take_rate('waitlist:ip1', 3, 3600), 'a new window didn''t start fresh');
select pg_temp.check((select count(*) from rate_buckets where bucket = 'waitlist:ip1') = 1, 'the old window wasn''t cleared');
select pg_temp.check((select used from rate_buckets where bucket = 'waitlist:ip1') = 1, 'the new window didn''t start at one');
-- A limit below one refuses everything; no bucket name is an error.
select pg_temp.check(not take_rate('waitlist:ip3', 0, 60), 'a zero limit let a use through');
select pg_temp.check(not exists (select 1 from rate_buckets where bucket = 'waitlist:ip3'), 'a zero limit counted a use');
select pg_temp.check(pg_temp.err($q$select take_rate('', 3, 60)$q$) = 'A bucket name is needed', 'a use without a bucket worked');
-- prune_rate_buckets clears windows that started over a day ago, and keeps the rest.
update rate_buckets set window_start = now() - interval '2 days' where bucket = 'waitlist:ip2';
select prune_rate_buckets();
select pg_temp.check(not exists (select 1 from rate_buckets where bucket = 'waitlist:ip2'), 'an old window wasn''t pruned');
select pg_temp.check(exists (select 1 from rate_buckets where bucket = 'waitlist:ip1'), 'a current window was pruned');
reset role;

commit;

\o
select 'rate tests passed' as result;
