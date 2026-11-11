-- PulseARR migration 007: the waitlist behind POST /api/waitlist (the pulsearr.com form). One row per email.
-- The route rate limits per IP with take_rate('waitlist:' || ip_hash, ...) before calling add_to_waitlist.
-- Server only: RLS on with no policies, and the function is executable by service_role alone.
--
--   add_to_waitlist(p_email text, p_source text default null, p_ip_hash text default null) returns boolean
--     Saves the email lowercased. True when it was added, false when it was already on the list.
--     Raises 'Enter a valid email' for anything that isn't one.

create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email) and char_length(email) <= 254),
  source text check (char_length(source) <= 100),
  ip_hash text check (char_length(ip_hash) <= 128),
  created_at timestamptz not null default now()
);
alter table public.waitlist enable row level security;
revoke all on public.waitlist from public, anon, authenticated;
grant all on public.waitlist to service_role;

create or replace function public.add_to_waitlist(p_email text, p_source text default null, p_ip_hash text default null) returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  e text := lower(trim(coalesce(p_email, '')));
begin
  if char_length(e) > 254 or e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email'; end if;
  insert into waitlist (email, source, ip_hash)
  values (e, left(nullif(trim(p_source), ''), 100), left(nullif(trim(p_ip_hash), ''), 128))
  on conflict (email) do nothing;
  return found;
end;
$fn$;

revoke all on function public.add_to_waitlist(text, text, text) from public, anon, authenticated;
grant execute on function public.add_to_waitlist(text, text, text) to service_role;
