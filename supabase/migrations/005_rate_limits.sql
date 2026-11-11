-- PulseARR migration 005: rate limits (Arrowsterr's 016 rate_buckets/take_rate, with a window length per call).
-- A fixed window per bucket, shared by every server process and the worker: 'waitlist:<ip hash>', 'stripe:<account>'.
-- Server only: RLS on with no policies, and the functions are executable by service_role alone.
--
--   take_rate(p_bucket text, p_limit int, p_window_s int) returns boolean
--     Count one use of the bucket in the current window of p_window_s seconds (1..86400). True when it is within
--     p_limit uses, false when the limit is reached (the use is not counted). Clears the bucket's older windows.
--   prune_rate_buckets() returns void
--     Delete windows that started over a day ago (buckets nobody used since). Called by the worker's tick.

create table if not exists public.rate_buckets (
  bucket text not null check (char_length(bucket) between 1 and 200),
  window_start timestamptz not null,
  used int not null default 0,
  primary key (bucket, window_start)
);
create index if not exists rate_buckets_window on public.rate_buckets (window_start);
alter table public.rate_buckets enable row level security;
revoke all on public.rate_buckets from public, anon, authenticated;
grant all on public.rate_buckets to service_role;

create or replace function public.take_rate(p_bucket text, p_limit int, p_window_s int) returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  w int := least(greatest(coalesce(p_window_s, 60), 1), 86400);
  start_at timestamptz := to_timestamp(floor(extract(epoch from now()) / w) * w);
  got int;
begin
  if coalesce(p_bucket, '') = '' then raise exception 'A bucket name is needed'; end if;
  if coalesce(p_limit, 0) < 1 then return false; end if;
  insert into rate_buckets as b (bucket, window_start, used) values (p_bucket, start_at, 1)
  on conflict (bucket, window_start) do update set used = b.used + 1 where b.used < p_limit
  returning b.used into got;
  delete from rate_buckets where bucket = p_bucket and window_start < start_at;
  return got is not null;
end;
$fn$;

create or replace function public.prune_rate_buckets() returns void
language sql security definer set search_path = public as $fn$
  delete from rate_buckets where window_start < now() - interval '1 day';
$fn$;

revoke all on function public.take_rate(text, int, int) from public, anon, authenticated;
revoke all on function public.prune_rate_buckets() from public, anon, authenticated;
grant execute on function public.take_rate(text, int, int) to service_role;
grant execute on function public.prune_rate_buckets() to service_role;
