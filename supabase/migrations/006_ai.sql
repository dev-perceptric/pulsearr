-- PulseARR migration 006: the AI step cache and daily AI limits, for askClaude() in src/lib/ai.ts. Nothing calls
-- them in M0. A step whose cache key is in ai_cache replays the saved response and never calls the model.
-- Server only: RLS on with no policies, and use_ai is executable by service_role alone.
--
--   ai_cache(key, model, response, created_at, last_used_at, hits)   read and written by the server directly
--   use_ai(p_ws uuid, p_kind text, p_limit int) returns boolean
--     Count one AI call of that kind for the workspace today (UTC). True when it is within p_limit calls today,
--     false when the limit is reached (the call is not counted).

create table if not exists public.ai_cache (
  key text primary key,
  model text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  hits int not null default 0
);
create index if not exists ai_cache_created on public.ai_cache (created_at);
alter table public.ai_cache enable row level security;
revoke all on public.ai_cache from public, anon, authenticated;
grant all on public.ai_cache to service_role;

create table if not exists public.ai_usage (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  day date not null,
  kind text not null check (char_length(kind) between 1 and 60),
  count int not null default 0,
  primary key (workspace_id, day, kind)
);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from public, anon, authenticated;
grant all on public.ai_usage to service_role;

create or replace function public.use_ai(p_ws uuid, p_kind text, p_limit int) returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  got int;
begin
  if coalesce(p_limit, 0) < 1 then return false; end if;
  insert into ai_usage as u (workspace_id, day, kind, count) values (p_ws, (now() at time zone 'utc')::date, p_kind, 1)
  on conflict (workspace_id, day, kind) do update set count = u.count + 1 where u.count < p_limit
  returning u.count into got;
  return got is not null;
end;
$fn$;

revoke all on function public.use_ai(uuid, text, int) from public, anon, authenticated;
grant execute on function public.use_ai(uuid, text, int) to service_role;
