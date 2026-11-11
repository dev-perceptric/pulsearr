-- The jobs queue (003_jobs.sql), ported from Claritia's tests/db/jobs.sql: one waiting job per key, one at a
-- time per key, claim order, leases that run out, the retry schedule, no-retry and retry-after, waiting without
-- using an attempt, and pruning. Runs as the server (service_role), the only role allowed to use the queue.
\set ON_ERROR_STOP on
set client_min_messages = warning;
\o /dev/null

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'JOBS TEST FAILED: %', what; end if;
end $$;
create function pg_temp.err(q text) returns text language plpgsql as $$
begin
  execute q;
  return null;
exception when others then
  return sqlerrm;
end $$;
create temp table ids (name text primary key, id uuid);
grant all on ids to service_role;
create function pg_temp.id(n text) returns uuid language sql as $$ select id from ids where name = n $$;
-- A job's wait from now, in seconds.
create function pg_temp.wait_s(n text) returns int language sql as $$
  select round(extract(epoch from (j.run_after - now())))::int from public.jobs j where j.id = (select id from ids where name = n)
$$;

insert into workspaces (id, name) values
  ('99999999-0000-0000-0000-000000000001', 'Queue test'),
  ('99999999-0000-0000-0000-000000000002', 'Queue test two');
set role service_role;

-- Kinds: lowercase dotted names only.
select pg_temp.check(enqueue_job(null, 'email.invite', '', '{}') is not null, 'a dotted kind was refused');
select pg_temp.check(enqueue_job(null, 'stripe.sync_events', '', '{}') is not null, 'a dotted kind with _ was refused');
select pg_temp.check(pg_temp.err($q$select enqueue_job(null, 'Email.Invite')$q$) like '%jobs_kind_check%', 'a kind with capitals was taken');
select pg_temp.check(pg_temp.err($q$select enqueue_job(null, 'email..invite')$q$) like '%jobs_kind_check%', 'a kind with an empty part was taken');
select pg_temp.check(pg_temp.err($q$select enqueue_job(null, '.invite')$q$) like '%jobs_kind_check%', 'a kind starting with a dot was taken');
delete from jobs;

-- Dedupe: three adds with the same key make one waiting job with the last payload and the earliest start.
insert into ids select 'a', enqueue_job('99999999-0000-0000-0000-000000000001', 'stitch', 'dev-1', '{"n":1}', 60);
select pg_temp.check(enqueue_job('99999999-0000-0000-0000-000000000001', 'stitch', 'dev-1', '{"n":2}', 0) = pg_temp.id('a'), 'a second add with the same key made a new job');
select enqueue_job('99999999-0000-0000-0000-000000000001', 'stitch', 'dev-1', '{"n":3}', 600);
select pg_temp.check((select count(*) from jobs where kind = 'stitch') = 1, 'the same key made more than one waiting job');
select pg_temp.check((select payload->>'n' from jobs where kind = 'stitch') = '3', 'the waiting job didn''t take the newest payload');
select pg_temp.check((select run_after <= now() + interval '1 second' from jobs where kind = 'stitch'), 'the waiting job lost its earlier start time');
-- The same key in another workspace, or with no workspace, and no key at all, don't collapse. No workspace twice does.
select enqueue_job('99999999-0000-0000-0000-000000000002', 'stitch', 'dev-1', '{}');
select enqueue_job(null, 'stitch', 'dev-1', '{}');
select enqueue_job(null, 'stitch', 'dev-1', '{}');
select enqueue_job('99999999-0000-0000-0000-000000000001', 'stitch', '', '{}');
select enqueue_job('99999999-0000-0000-0000-000000000001', 'stitch', '', '{}');
select pg_temp.check((select count(*) from jobs where kind = 'stitch') = 5, 'jobs with no key, or another workspace, collapsed (or no workspace didn''t)');
delete from jobs;

-- Claiming: only the kinds asked for, only ready jobs.
select enqueue_job('99999999-0000-0000-0000-000000000001', 'score', 'acct-1', '{}');
select enqueue_job('99999999-0000-0000-0000-000000000001', 'score', 'acct-later', '{}', 3600);
select enqueue_job('99999999-0000-0000-0000-000000000001', 'other', 'x', '{}');
insert into ids select 'c1', id from claim_job('{score}', 'w1', 60, 10);
select pg_temp.check((select count(*) from ids where name = 'c1') = 1, 'claimed a job not ready yet, or of another kind');
select pg_temp.check((select status = 'running' and attempts = 1 and locked_by = 'w1' and locked_until > now() + interval '50 seconds'
  from jobs where id = pg_temp.id('c1')), 'a claimed job isn''t running with one attempt and a lease');
select pg_temp.check(not exists (select 1 from claim_job('{score}', 'w2', 60, 10)), 'a second worker took a job already taken');
select pg_temp.check(pg_temp.err($q$select * from claim_job('{score}', '', 60, 1)$q$) = 'A worker name is needed', 'a claim without a worker name worked');

-- One at a time per key: a new job for a key that is running waits until the running one finishes.
select enqueue_job('99999999-0000-0000-0000-000000000001', 'score', 'acct-1', '{"again":true}');
select pg_temp.check((select count(*) from jobs where key = 'acct-1') = 2, 'an add while running didn''t wait in line');
select pg_temp.check(not exists (select 1 from claim_job('{score}', 'w2', 60, 10)), 'two jobs for the same key ran at once');
select pg_temp.check(not finish_job(pg_temp.id('c1'), 'w2', true), 'another worker finished a job it didn''t hold');
select pg_temp.check(finish_job(pg_temp.id('c1'), 'w1', true), 'the worker couldn''t finish its job');
select pg_temp.check((select status = 'done' and finished_at is not null and locked_by is null from jobs where id = pg_temp.id('c1')), 'a finished job isn''t done');
insert into ids select 'c2', id from claim_job('{score}', 'w2', 60, 10);
select pg_temp.check((select payload->>'again' from jobs where id = pg_temp.id('c2')) = 'true', 'the waiting job for the key didn''t run after the first finished');
select finish_job(pg_temp.id('c2'), 'w2', true);
delete from jobs;

-- Claim order: oldest run_after first, across calls and within one call.
insert into ids select 'o1', enqueue_job(null, 'order', 'k1', '{}');
insert into ids select 'o2', enqueue_job(null, 'order', 'k2', '{}');
insert into ids select 'o3', enqueue_job(null, 'order', 'k3', '{}');
update jobs set run_after = now() - interval '1 minute' where id = pg_temp.id('o1');
update jobs set run_after = now() - interval '3 minutes' where id = pg_temp.id('o2');
update jobs set run_after = now() - interval '2 minutes' where id = pg_temp.id('o3');
select pg_temp.check((select id from claim_job('{order}', 'w', 60, 1)) = pg_temp.id('o2'), 'the oldest job wasn''t claimed first');
select pg_temp.check((select id from claim_job('{order}', 'w', 60, 1)) = pg_temp.id('o3'), 'the second oldest job wasn''t claimed second');
select pg_temp.check((select id from claim_job('{order}', 'w', 60, 1)) = pg_temp.id('o1'), 'the newest job wasn''t claimed last');
delete from jobs;
-- null kinds claims every kind.
select enqueue_job(null, 'any.one', '', '{}');
select enqueue_job(null, 'any.two', '', '{}');
select pg_temp.check((select count(*) from claim_job(null, 'w', 60, 10)) = 2, 'claiming with no kinds didn''t take every kind');
delete from jobs;

-- Retries: 1 min, 5 min, 30 min, 2 h, 6 h; the last attempt fails for good.
insert into ids select 'r', enqueue_job(null, 'retry', 'r-1', '{}', 0, 6);
do $$
declare
  want int[] := array[60, 300, 1800, 7200, 21600];
  jid uuid := (select id from ids where name = 'r');
  got int;
begin
  for i in 1..5 loop
    update jobs set run_after = now() where id = jid;
    perform claim_job('{retry}', 'w', 60, 1);
    perform finish_job(jid, 'w', false, 'Stripe said 503 #' || i);
    got := pg_temp.wait_s('r');
    if (select status from jobs where id = jid) <> 'queued' or abs(got - want[i]) > 2 then
      raise exception 'JOBS TEST FAILED: retry % waits % s, not % s', i, got, want[i];
    end if;
  end loop;
end $$;
select pg_temp.check((select attempts = 5 and last_error = 'Stripe said 503 #5' and locked_by is null from jobs where id = pg_temp.id('r')), 'a retried job lost its count or error');
update jobs set run_after = now() where id = pg_temp.id('r');
select claim_job('{retry}', 'w', 60, 1);
select finish_job(pg_temp.id('r'), 'w', false, 'still broken');
select pg_temp.check((select status = 'failed' and finished_at is not null and last_error = 'still broken' from jobs where id = pg_temp.id('r')), 'the last attempt didn''t fail for good');
-- Don't try again at all (JobError retry: false).
insert into ids select 'n', enqueue_job(null, 'retry', 'r-2', '{}');
select claim_job('{retry}', 'w', 60, 1);
select finish_job(pg_temp.id('n'), 'w', false, 'bad input', -1);
select pg_temp.check((select status from jobs where id = pg_temp.id('n')) = 'failed', 'a job marked not to retry was retried');
-- Try again after a given wait (JobError retryAfterS), still counting the attempt.
insert into ids select 'ra', enqueue_job(null, 'retry', 'r-3', '{}');
select claim_job('{retry}', 'w', 60, 1);
select finish_job(pg_temp.id('ra'), 'w', false, 'busy', 120);
select pg_temp.check((select status = 'queued' and attempts = 1 from jobs where id = pg_temp.id('ra')) and abs(pg_temp.wait_s('ra') - 120) <= 2, 'retry after 120 s didn''t wait 120 s');
-- A failure while a newer job for the key waits fails this one; the newer one carries on.
insert into ids select 'f1', enqueue_job(null, 'retry', 'r-4', '{"v":1}');
select claim_job('{retry}', 'w', 60, 1);
insert into ids select 'f2', enqueue_job(null, 'retry', 'r-4', '{"v":2}');
select finish_job(pg_temp.id('f1'), 'w', false, 'old');
select pg_temp.check((select status from jobs where id = pg_temp.id('f1')) = 'failed' and (select status from jobs where id = pg_temp.id('f2')) = 'queued', 'a failure with a newer job waiting wasn''t closed');
delete from jobs;

-- Waiting without using an attempt (defer_job).
insert into ids select 'd', enqueue_job(null, 'stripe.sync', 'acct-9', '{"cursor":"a"}', 0, 2);
select claim_job('{stripe.sync}', 'w', 60, 1);
select finish_job(pg_temp.id('d'), 'w', false, 'first failure'); -- attempt 1 used
update jobs set run_after = now() where id = pg_temp.id('d');
select claim_job('{stripe.sync}', 'w', 60, 1); -- attempt 2: the last
select pg_temp.check(not defer_job(pg_temp.id('d'), 'other', 30), 'another worker deferred a job it didn''t hold');
select pg_temp.check(defer_job(pg_temp.id('d'), 'w', 30, '{"cursor":"b"}'), 'the worker couldn''t defer its job');
select pg_temp.check((select status = 'queued' and attempts = 1 and locked_by is null and locked_until is null and payload->>'cursor' = 'b'
  and last_error = 'first failure' from jobs where id = pg_temp.id('d')), 'deferring used an attempt, kept the lease, or lost the payload or error');
select pg_temp.check(abs(pg_temp.wait_s('d') - 30) <= 2, 'deferring didn''t wait 30 s');
select pg_temp.check(not exists (select 1 from claim_job('{stripe.sync}', 'w', 60, 1)), 'a deferred job ran before its wait');
-- Deferring many times never uses up the attempts: it is still on its last one, and may still run.
do $$
begin
  for i in 1..5 loop
    update jobs set run_after = now() where id = (select id from ids where name = 'd');
    perform claim_job('{stripe.sync}', 'w', 60, 1);
    perform defer_job((select id from ids where name = 'd'), 'w', 5);
  end loop;
end $$;
select pg_temp.check((select status = 'queued' and attempts = 1 from jobs where id = pg_temp.id('d')), 'repeated waits used up attempts');
-- Without a payload the payload stays; the wait is kept between 1 s and a day.
update jobs set run_after = now() where id = pg_temp.id('d');
select claim_job('{stripe.sync}', 'w', 60, 1);
select defer_job(pg_temp.id('d'), 'w', 999999);
select pg_temp.check((select payload->>'cursor' from jobs where id = pg_temp.id('d')) = 'b' and abs(pg_temp.wait_s('d') - 86400) <= 2, 'a defer without payload changed it, or the wait isn''t capped at a day');
-- finish_job with p_wait_s (JobError waitS) waits the same way, keeping the error; five-argument calls still work.
update jobs set run_after = now() where id = pg_temp.id('d');
select claim_job('{stripe.sync}', 'w', 60, 1);
select pg_temp.check(finish_job(p_id => pg_temp.id('d'), p_worker => 'w', p_ok => false, p_error => 'Stripe said 429', p_retry_s => null, p_wait_s => 20),
  'finish_job couldn''t wait');
select pg_temp.check((select status = 'queued' and attempts = 1 and last_error = 'Stripe said 429' and locked_by is null from jobs where id = pg_temp.id('d'))
  and abs(pg_temp.wait_s('d') - 20) <= 2, 'finish_job with p_wait_s used an attempt, lost the error or didn''t wait 20 s');
select pg_temp.check(not finish_job(p_id => pg_temp.id('d'), p_worker => 'w', p_ok => false, p_error => 'x', p_wait_s => 20), 'a job not held was waited by finish_job');
-- Deferring while a newer job for the key waits closes this one and makes the newer one wait as long.
update jobs set run_after = now() where id = pg_temp.id('d');
select claim_job('{stripe.sync}', 'w', 60, 1);
insert into ids select 'd2', enqueue_job(null, 'stripe.sync', 'acct-9', '{"cursor":"new"}');
select pg_temp.check(defer_job(pg_temp.id('d'), 'w', 45), 'deferring with a newer job waiting failed');
select pg_temp.check((select status = 'done' from jobs where id = pg_temp.id('d')) and (select status = 'queued' from jobs where id = pg_temp.id('d2'))
  and abs(pg_temp.wait_s('d2') - 45) <= 2, 'deferring with a newer job waiting didn''t hand the wait to it');
select pg_temp.check(not defer_job(pg_temp.id('d'), 'w', 45), 'a closed job was deferred');
delete from jobs;

-- Leases: a worker that stops answering loses its job, which goes back in line and runs again.
insert into ids select 'l', enqueue_job('99999999-0000-0000-0000-000000000001', 'lookup', 'net-1', '{}');
select claim_job('{lookup}', 'dead', 60, 1);
select pg_temp.check(extend_job(pg_temp.id('l'), 'dead', 120), 'the worker couldn''t keep its lease');
select pg_temp.check((select locked_until > now() + interval '110 seconds' from jobs where id = pg_temp.id('l')), 'extend_job didn''t move the lease');
update jobs set locked_until = now() - interval '1 second' where id = pg_temp.id('l');
insert into ids select 'l2', id from claim_job('{lookup}', 'alive', 60, 1);
select pg_temp.check(pg_temp.id('l2') = pg_temp.id('l'), 'a job with a lapsed lease wasn''t taken again');
select pg_temp.check((select attempts = 2 and locked_by = 'alive' from jobs where id = pg_temp.id('l')), 'a retaken job didn''t count the attempt');
select pg_temp.check(not finish_job(pg_temp.id('l'), 'dead', true), 'the worker that lost the lease still finished the job');
select pg_temp.check(not extend_job(pg_temp.id('l'), 'dead', 60), 'the worker that lost the lease still kept it');
select pg_temp.check(not defer_job(pg_temp.id('l'), 'dead', 60), 'the worker that lost the lease still deferred it');
select finish_job(pg_temp.id('l'), 'alive', true);
-- A lapsed job whose key already has a newer job waiting is dropped, and the newer one runs.
insert into ids select 'old', enqueue_job('99999999-0000-0000-0000-000000000001', 'lookup', 'net-2', '{"v":"old"}');
select claim_job('{lookup}', 'dead', 60, 1);
select enqueue_job('99999999-0000-0000-0000-000000000001', 'lookup', 'net-2', '{"v":"new"}');
update jobs set locked_until = now() - interval '1 second' where id = pg_temp.id('old');
insert into ids select 'new', id from claim_job('{lookup}', 'alive', 60, 1);
select pg_temp.check((select payload->>'v' from jobs where id = pg_temp.id('new')) = 'new', 'the newer job for the key didn''t run');
select pg_temp.check((select status from jobs where id = pg_temp.id('old')) = 'done', 'the replaced job wasn''t closed');
-- A lapsed job on its last attempt fails instead of running again.
insert into ids select 'last', enqueue_job('99999999-0000-0000-0000-000000000001', 'lookup', 'net-3', '{}', 0, 1);
select claim_job('{lookup}', 'dead', 60, 1);
update jobs set locked_until = now() - interval '1 second' where id = pg_temp.id('last');
select claim_job('{lookup}', 'alive', 60, 1);
select pg_temp.check((select status = 'failed' and last_error = 'The worker stopped answering' from jobs where id = pg_temp.id('last')), 'a lapsed job on its last attempt ran again');
delete from jobs;

-- Pruning: done jobs kept 7 days, failed ones 30; waiting and running jobs stay.
insert into jobs (kind, status, finished_at) values
  ('prune.done_old', 'done', now() - interval '8 days'),
  ('prune.done_new', 'done', now() - interval '6 days'),
  ('prune.failed_old', 'failed', now() - interval '31 days'),
  ('prune.failed_new', 'failed', now() - interval '29 days'),
  ('prune.queued', 'queued', null),
  ('prune.running', 'running', null);
select pg_temp.check(prune_jobs() = 2, 'prune_jobs didn''t say how many it cleared');
select pg_temp.check((select array_agg(kind order by kind) from jobs) = array['prune.done_new', 'prune.failed_new', 'prune.queued', 'prune.running'],
  'prune_jobs kept or cleared the wrong jobs');
delete from jobs;
reset role;

\o
select 'jobs tests passed' as result;
