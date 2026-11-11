-- PulseARR migration 002: workspaces, members and invites (from Omniscient's schema.sql and 006_teams.sql).
-- Members read their workspace's rows through row level security. Nobody writes these tables directly: every
-- change goes through the checked functions in 004_team.sql. The server (service_role) may read and write.
--
--   is_member(ws uuid) returns boolean   the caller is in the workspace
--   is_admin(ws uuid)  returns boolean   the caller is its owner or an admin
--   is_owner(ws uuid)  returns boolean   the caller is its owner

-- Workspaces -------------------------------------------------------------------

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Members ----------------------------------------------------------------------
-- owner: exactly one per workspace, deletes it. admin: manages the team. member: everything else.

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  email text not null, -- lowercased, from the sign-in, so the team page needs no read of auth.users
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists workspace_members_user on public.workspace_members (user_id);
create unique index if not exists workspace_members_one_owner on public.workspace_members (workspace_id) where role = 'owner';

-- Invites ----------------------------------------------------------------------
-- Signing in with an invited email joins the workspace (ensure_workspace). No link or token needed.

create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) <= 254),
  role text not null default 'member' check (role in ('admin', 'member')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, email)
);
create index if not exists invites_email on public.invites (email);

-- Who the caller is in a workspace ---------------------------------------------

create or replace function public.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from workspace_members where workspace_id = ws and user_id = auth.uid());
$fn$;

create or replace function public.is_admin(ws uuid) returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from workspace_members where workspace_id = ws and user_id = auth.uid() and role in ('owner', 'admin'));
$fn$;

create or replace function public.is_owner(ws uuid) returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from workspace_members where workspace_id = ws and user_id = auth.uid() and role = 'owner');
$fn$;

revoke all on function public.is_member(uuid) from public, anon;
revoke all on function public.is_admin(uuid) from public, anon;
revoke all on function public.is_owner(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated, service_role;
grant execute on function public.is_admin(uuid) to authenticated, service_role;
grant execute on function public.is_owner(uuid) to authenticated, service_role;

-- Row level security -----------------------------------------------------------
-- Read only. No insert, update or delete policies, and no write grants: writes go through 004's functions.

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.invites enable row level security;

drop policy if exists "members read" on public.workspaces;
create policy "members read" on public.workspaces for select to authenticated using (is_member(id));

drop policy if exists "members read" on public.workspace_members;
create policy "members read" on public.workspace_members for select to authenticated using (is_member(workspace_id));

drop policy if exists "admins read" on public.invites;
create policy "admins read" on public.invites for select to authenticated using (is_admin(workspace_id));

revoke all on public.workspaces, public.workspace_members, public.invites from public, anon, authenticated;
grant select on public.workspaces, public.workspace_members, public.invites to authenticated;
grant all on public.workspaces, public.workspace_members, public.invites to service_role;
