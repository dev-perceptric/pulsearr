-- PulseARR migration 003: the jobs queue (Claritia's 020_foundation.sql jobs design, plus Arrowsterr's
-- "wait without using an attempt"). One queue for background work. The worker claims jobs straight from Postgres
-- with skip locked, holds a lease while it works (renewing it every third of its length), and finishes them.
-- Jobs that share (workspace_id, kind, key) never run at the same time, and at most one waits per key, so a burst
-- of adds for one key becomes one job. There is no pg_cron: the worker calls prune_jobs() from its own tick.
-- Server only: RLS on with no policies, and every function is executable by service_role alone.
--
-- Functions (the contract src/lib/jobs.ts and worker/ code against; names and parameters match Claritia's):
--
--   enqueue_job(p_workspace uuid, p_kind text, p_key text default '', p_payload jsonb default '{}',
--               p_delay_s int default 0, p_max_attempts int default 5) returns uuid
--     Add a job. With a non-empty key, a job already waiting for (workspace, kind, key) takes the new payload and
--     the earlier start time, and its id is returned. p_workspace may be null for jobs that belong to no workspace.
--
--   claim_job(p_kinds text[], p_worker text, p_lease_s int default 300, p_limit int default 1) returns setof jobs
--     Take up to p_limit (1..100) ready jobs of those kinds (null = every kind), oldest run_after first, counting
--     one attempt each. First, jobs whose lease ran out go back in line, or fail after their last attempt, or are
--     closed when a newer job for the same key already waits. A queued job never starts while its key is running.
--
--   extend_job(p_id uuid, p_worker text, p_lease_s int default 300) returns boolean
--     Renew the lease. False means the lease was lost: stop working on the job.
--
--   finish_job(p_id uuid, p_worker text, p_ok boolean, p_error text default null, p_retry_s int default null,
--              p_wait_s int default null) returns boolean
--     p_ok = true: done. p_ok = false: tried again after 1 min, 5 min, 30 min, 2 h, then 6 h (by attempt), or
--     after p_retry_s seconds when given (JobError retryAfterS); p_retry_s = -1 means don't retry (JobError
--     retry: false). Fails for good after max_attempts, or when a newer job for the same key already waits.
--     p_ok = false with p_wait_s (JobError waitS): wait without using an attempt, as defer_job, keeping p_error
--     as last_error; p_retry_s is then ignored. False means the caller no longer holds the lease: nothing changed.
--
--   defer_job(p_id uuid, p_worker text, p_wait_s int, p_payload jsonb default null) returns boolean
--     Wait without using an attempt (rate limits, e.g. Stripe 429s in M1): back in line after p_wait_s seconds
--     (1..86400), with the attempt this claim counted given back, last_error untouched, and the payload replaced
--     when p_payload is given (a cursor to resume from). When a newer job for the same key already waits, this
--     one is closed as done and the newer one waits at least as long. False means the lease was lost.
--
--   prune_jobs() returns int
--     Delete done jobs finished over 7 days ago and failed ones over 30 days ago; returns how many. Called by
--     the worker's tick.

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces (id) on delete cascade,
  -- Lowercase dotted names: email.invite, jobs.prune, stripe.sync.
  kind text not null check (char_length(kind) <= 60 and kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  -- Jobs with the same workspace, kind and key run one at a time, and only one waits. Empty means no limit.
  key text not null default '' check (char_length(key) <= 200),
  payload jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  run_after timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 5 check (max_attempts between 1 and 20),
  locked_by text,
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists jobs_one_waiting on public.jobs (workspace_id, kind, key) nulls not distinct
  where status = 'queued' and key <> '';
create index if not exists jobs_ready on public.jobs (kind, run_after) where status = 'queued';
create index if not exists jobs_running on public.jobs (kind, locked_until) where status = 'running';
create index if not exists jobs_finished on public.jobs (finished_at) where status in ('done', 'failed');
create index if not exists jobs_workspace on public.jobs (workspace_id);
alter table public.jobs enable row level security;
revoke all on public.jobs from public, anon, authenticated;
grant all on public.jobs to service_role;

create or replace function public.enqueue_job(p_workspace uuid, p_kind text, p_key text default '', p_payload jsonb default '{}',
  p_delay_s int default 0, p_max_attempts int default 5) returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  jid uuid;
begin
  insert into jobs (workspace_id, kind, key, payload, run_after, max_attempts)
  values (p_workspace, p_kind, coalesce(p_key, ''), coalesce(p_payload, '{}'),
          now() + make_interval(secs => greatest(coalesce(p_delay_s, 0), 0)), coalesce(p_max_attempts, 5))
  on conflict (workspace_id, kind, key) where status = 'queued' and key <> ''
  do update set payload = excluded.payload, run_after = least(jobs.run_after, excluded.run_after)
  returning id into jid;
  return jid;
end;
$fn$;

create or replace function public.claim_job(p_kinds text[], p_worker text, p_lease_s int default 300, p_limit int default 1)
returns setof public.jobs
language plpgsql security definer set search_path = public as $fn$
begin
  if coalesce(p_worker, '') = '' then
    raise exception 'A worker name is needed';
  end if;

  -- Leases that ran out, on their last attempt or with a newer job waiting for the same key: closed.
  update jobs j set
    status = case when j.attempts >= j.max_attempts then 'failed' else 'done' end,
    last_error = case when j.attempts >= j.max_attempts then 'The worker stopped answering' else 'Replaced by a newer job for the same key' end,
    finished_at = now(), locked_by = null, locked_until = null
  where j.id in (
    select x.id from jobs x
    where (p_kinds is null or x.kind = any(p_kinds)) and x.status = 'running' and x.locked_until < now()
      and (x.attempts >= x.max_attempts
           or (x.key <> '' and exists (select 1 from jobs w where w.status = 'queued' and w.kind = x.kind and w.key = x.key
                                       and w.workspace_id is not distinct from x.workspace_id)))
    for update skip locked
  );
  -- The other leases that ran out: back in line now.
  update jobs j set status = 'queued', run_after = now(), locked_by = null, locked_until = null,
    last_error = 'The worker stopped answering; trying again'
  where j.id in (
    select x.id from jobs x
    where (p_kinds is null or x.kind = any(p_kinds)) and x.status = 'running' and x.locked_until < now()
      and (x.key = '' or not exists (select 1 from jobs w where w.status = 'queued' and w.kind = x.kind and w.key = x.key
                                     and w.workspace_id is not distinct from x.workspace_id))
    for update skip locked
  );

  return query
  update jobs j set status = 'running', locked_by = p_worker, attempts = j.attempts + 1,
    locked_until = now() + make_interval(secs => greatest(coalesce(p_lease_s, 300), 10))
  where j.id in (
    select x.id from jobs x
    where (p_kinds is null or x.kind = any(p_kinds)) and x.status = 'queued' and x.run_after <= now()
      and (x.key = '' or not exists (select 1 from jobs r where r.status = 'running' and r.kind = x.kind and r.key = x.key
                                     and r.workspace_id is not distinct from x.workspace_id))
    order by x.run_after, x.created_at
    limit greatest(least(coalesce(p_limit, 1), 100), 1)
    for update skip locked
  )
  returning j.*;
end;
$fn$;

create or replace function public.extend_job(p_id uuid, p_worker text, p_lease_s int default 300) returns boolean
language plpgsql security definer set search_path = public as $fn$
begin
  update jobs set locked_until = now() + make_interval(secs => greatest(coalesce(p_lease_s, 300), 10))
  where id = p_id and status = 'running' and locked_by = p_worker;
  return found;
end;
$fn$;

create or replace function public.defer_job(p_id uuid, p_worker text, p_wait_s int, p_payload jsonb default null) returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  j jobs;
  until_at timestamptz := now() + make_interval(secs => least(greatest(coalesce(p_wait_s, 60), 1), 86400));
begin
  select * into j from jobs where id = p_id and status = 'running' and locked_by = p_worker for update;
  if not found then
    return false;
  end if;
  if j.key <> '' and exists (select 1 from jobs w where w.status = 'queued' and w.kind = j.kind and w.key = j.key
                             and w.workspace_id is not distinct from j.workspace_id) then
    update jobs w set run_after = greatest(w.run_after, until_at)
    where w.status = 'queued' and w.kind = j.kind and w.key = j.key and w.workspace_id is not distinct from j.workspace_id;
    update jobs set status = 'done', last_error = 'Replaced by a newer job for the same key', finished_at = now(),
      locked_by = null, locked_until = null where id = p_id;
    return true;
  end if;
  update jobs set status = 'queued', attempts = greatest(attempts - 1, 0), run_after = until_at,
    payload = coalesce(p_payload, payload), locked_by = null, locked_until = null where id = p_id;
  return true;
end;
$fn$;

-- Only one finish_job: Claritia's five arguments plus p_wait_s. Calls by name with the five still work.
drop function if exists public.finish_job(uuid, text, boolean, text, int);
create or replace function public.finish_job(p_id uuid, p_worker text, p_ok boolean, p_error text default null, p_retry_s int default null,
  p_wait_s int default null)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  j jobs;
  wait int;
begin
  if not coalesce(p_ok, false) and p_wait_s is not null then
    if not defer_job(p_id, p_worker, p_wait_s) then
      return false;
    end if;
    if p_error is not null then
      update jobs set last_error = left(p_error, 2000) where id = p_id and status = 'queued';
    end if;
    return true;
  end if;
  select * into j from jobs where id = p_id and status = 'running' and locked_by = p_worker for update;
  if not found then
    return false;
  end if;
  if p_ok then
    update jobs set status = 'done', last_error = null, finished_at = now(), locked_by = null, locked_until = null where id = p_id;
    return true;
  end if;
  if p_retry_s = -1 or j.attempts >= j.max_attempts
     or (j.key <> '' and exists (select 1 from jobs w where w.status = 'queued' and w.kind = j.kind and w.key = j.key
                                 and w.workspace_id is not distinct from j.workspace_id)) then
    update jobs set status = 'failed', last_error = left(coalesce(p_error, 'Failed'), 2000), finished_at = now(),
      locked_by = null, locked_until = null where id = p_id;
    return true;
  end if;
  wait := case when p_retry_s is null then (array[60, 300, 1800, 7200, 21600])[least(greatest(j.attempts, 1), 5)]
               else greatest(p_retry_s, 0) end;
  update jobs set status = 'queued', last_error = left(coalesce(p_error, 'Failed'), 2000), run_after = now() + make_interval(secs => wait),
    locked_by = null, locked_until = null where id = p_id;
  return true;
end;
$fn$;

create or replace function public.prune_jobs() returns int
language plpgsql security definer set search_path = public as $fn$
declare
  n int;
begin
  delete from jobs where (status = 'done' and finished_at < now() - interval '7 days')
                      or (status = 'failed' and finished_at < now() - interval '30 days');
  get diagnostics n = row_count;
  return n;
end;
$fn$;

revoke all on function public.enqueue_job(uuid, text, text, jsonb, int, int) from public, anon, authenticated;
revoke all on function public.claim_job(text[], text, int, int) from public, anon, authenticated;
revoke all on function public.extend_job(uuid, text, int) from public, anon, authenticated;
revoke all on function public.finish_job(uuid, text, boolean, text, int, int) from public, anon, authenticated;
revoke all on function public.defer_job(uuid, text, int, jsonb) from public, anon, authenticated;
revoke all on function public.prune_jobs() from public, anon, authenticated;
grant execute on function public.enqueue_job(uuid, text, text, jsonb, int, int) to service_role;
grant execute on function public.claim_job(text[], text, int, int) to service_role;
grant execute on function public.extend_job(uuid, text, int) to service_role;
grant execute on function public.finish_job(uuid, text, boolean, text, int, int) to service_role;
grant execute on function public.defer_job(uuid, text, int, jsonb) to service_role;
grant execute on function public.prune_jobs() to service_role;
