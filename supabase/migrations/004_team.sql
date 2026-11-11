-- PulseARR migration 004: the team and boot (from Omniscient's 006_teams.sql, 086_boot.sql and 115_signup.sql).
-- Every change to workspaces, members and invites goes through these checked functions. They run as the caller
-- (`authenticated`, through PostgREST), so auth.uid() and auth.jwt() say who is asking. Errors are short plain
-- lines people see (errcode P0001); a missing permission is always 'Not allowed'.
--
--   ensure_workspace(p_pref uuid default null) returns uuid
--     Accepts every invite for the caller's email (joins, deletes the invite), then returns p_pref when the caller
--     is in it, else the workspace they joined most recently, else a new one they own, named after their email's
--     company domain (acme.com -> 'Acme'; personal email -> 'My workspace').
--   boot(p_pref uuid default null) returns jsonb
--     { user: {id, email}, workspace: {id, name, role}, workspaces: [{id, name, role}] by name }
--   team(p_ws uuid) returns jsonb
--     { members: [{user_id, email, role, created_at}], invites: [{id, email, role, created_at}] }  (invites: admins only)
--   invite_member(p_ws uuid, p_email text, p_role text default 'member') returns uuid   admins; queues 'email.invite'
--   cancel_invite(p_invite uuid) returns void                                           admins
--   set_member_role(p_ws uuid, p_user uuid, p_role text) returns void                    admins; not the owner
--   remove_member(p_ws uuid, p_user uuid) returns void                                  admins, or yourself; not the owner
--   rename_workspace(p_ws uuid, p_name text) returns void                               admins
--   delete_workspace(p_ws uuid) returns void                                            the owner

-- Personal email domains: a workspace isn't named after these.
create or replace function public.is_free_domain(d text) returns boolean
language sql immutable set search_path = public as $fn$
  select lower(coalesce(d, '')) = any (array[
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com',
    'proton.me', 'protonmail.com', 'aol.com'
  ]);
$fn$;

-- The caller's email, lowercased: from the sign-in token, else from auth.users.
create or replace function public.my_email() returns text
language sql stable security definer set search_path = public as $fn$
  select nullif(lower(trim(coalesce(nullif(auth.jwt() ->> 'email', ''), (select u.email from auth.users u where u.id = auth.uid())))), '');
$fn$;

create or replace function public.ensure_workspace(p_pref uuid default null) returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  uid uuid := auth.uid();
  v_email text := my_email();
  d text;
  ws uuid;
begin
  if uid is null or v_email is null then raise exception 'Not signed in'; end if;
  -- One at a time per person, so two first loads never make two workspaces.
  perform pg_advisory_xact_lock(hashtextextended('ensure_workspace:' || uid::text, 0));

  with taken as (delete from invites where email = v_email returning workspace_id, role)
  insert into workspace_members (workspace_id, user_id, role, email)
  select t.workspace_id, uid, t.role, v_email from taken t
  on conflict (workspace_id, user_id) do nothing;

  if p_pref is not null and is_member(p_pref) then return p_pref; end if;
  select m.workspace_id into ws from workspace_members m where m.user_id = uid order by m.created_at desc limit 1;
  if ws is not null then return ws; end if;

  d := split_part(v_email, '@', 2);
  insert into workspaces (name, created_by)
  values (
    case when d = '' or is_free_domain(d) or split_part(d, '.', 1) = '' then 'My workspace'
         else left(initcap(split_part(d, '.', 1)), 80) end,
    uid
  )
  returning id into ws;
  insert into workspace_members (workspace_id, user_id, role, email) values (ws, uid, 'owner', v_email);
  return ws;
end;
$fn$;

create or replace function public.boot(p_pref uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  uid uuid := auth.uid();
  ws uuid;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  ws := ensure_workspace(p_pref);
  return jsonb_build_object(
    'user', jsonb_build_object('id', uid, 'email', my_email()),
    'workspace', (
      select jsonb_build_object('id', w.id, 'name', w.name, 'role', m.role)
      from workspaces w join workspace_members m on m.workspace_id = w.id and m.user_id = uid
      where w.id = ws
    ),
    'workspaces', coalesce((
      select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'role', m.role) order by lower(w.name), w.created_at, w.id)
      from workspaces w join workspace_members m on m.workspace_id = w.id and m.user_id = uid
    ), '[]'::jsonb)
  );
end;
$fn$;

create or replace function public.team(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not is_member(p_ws) then raise exception 'Not allowed'; end if;
  return jsonb_build_object(
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', m.email, 'role', m.role, 'created_at', m.created_at)
                       order by m.created_at, m.email)
      from workspace_members m where m.workspace_id = p_ws
    ), '[]'::jsonb),
    'invites', case when is_admin(p_ws) then coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role, 'created_at', i.created_at)
                       order by i.created_at, i.email)
      from invites i where i.workspace_id = p_ws
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$fn$;

create or replace function public.invite_member(p_ws uuid, p_email text, p_role text default 'member') returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  e text := lower(trim(coalesce(p_email, '')));
  iid uuid;
begin
  if not is_admin(p_ws) then raise exception 'Not allowed'; end if;
  if p_role is null or p_role not in ('admin', 'member') then raise exception 'Pick admin or member'; end if;
  if char_length(e) > 254 or e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email'; end if;
  if exists (select 1 from workspace_members m where m.workspace_id = p_ws and m.email = e) then
    raise exception 'Already on the team';
  end if;
  insert into invites (workspace_id, email, role, invited_by) values (p_ws, e, p_role, auth.uid())
  on conflict (workspace_id, email) do update set role = excluded.role, invited_by = excluded.invited_by, created_at = now()
  returning id into iid;
  perform enqueue_job(p_ws, 'email.invite', iid::text,
    jsonb_build_object('invite_id', iid, 'workspace_id', p_ws, 'email', e, 'role', p_role, 'invited_by', auth.uid()));
  return iid;
end;
$fn$;

create or replace function public.cancel_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  ws uuid;
begin
  select workspace_id into ws from invites where id = p_invite;
  if ws is null then return; end if; -- already gone
  if not is_admin(ws) then raise exception 'Not allowed'; end if;
  delete from invites where id = p_invite;
end;
$fn$;

create or replace function public.set_member_role(p_ws uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  r text;
begin
  if not is_admin(p_ws) then raise exception 'Not allowed'; end if;
  if p_role is null or p_role not in ('admin', 'member') then raise exception 'Pick admin or member'; end if;
  select role into r from workspace_members where workspace_id = p_ws and user_id = p_user for update;
  if r is null then raise exception 'Not on the team'; end if;
  if r = 'owner' then raise exception 'The owner''s role can''t be changed'; end if;
  update workspace_members set role = p_role where workspace_id = p_ws and user_id = p_user;
end;
$fn$;

create or replace function public.remove_member(p_ws uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  r text;
begin
  if not is_member(p_ws) then raise exception 'Not allowed'; end if;
  select role into r from workspace_members where workspace_id = p_ws and user_id = p_user for update;
  if p_user is distinct from auth.uid() and not is_admin(p_ws) then raise exception 'Not allowed'; end if;
  if r is null then raise exception 'Not on the team'; end if;
  if r = 'owner' then
    if p_user = auth.uid() then raise exception 'The owner can''t leave the workspace'; end if;
    raise exception 'The owner can''t be removed';
  end if;
  delete from workspace_members where workspace_id = p_ws and user_id = p_user;
end;
$fn$;

create or replace function public.rename_workspace(p_ws uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  n text := trim(coalesce(p_name, ''));
begin
  if not is_admin(p_ws) then raise exception 'Not allowed'; end if;
  if char_length(n) < 1 or char_length(n) > 80 then raise exception 'Use a name of 1 to 80 characters'; end if;
  update workspaces set name = n where id = p_ws;
end;
$fn$;

create or replace function public.delete_workspace(p_ws uuid) returns void
language plpgsql security definer set search_path = public as $fn$
begin
  if not is_owner(p_ws) then raise exception 'Not allowed'; end if;
  delete from workspaces where id = p_ws; -- members, invites, jobs and usage go with it
end;
$fn$;

revoke all on function public.is_free_domain(text) from public, anon;
revoke all on function public.my_email() from public, anon, authenticated;
revoke all on function public.ensure_workspace(uuid) from public, anon;
revoke all on function public.boot(uuid) from public, anon;
revoke all on function public.team(uuid) from public, anon;
revoke all on function public.invite_member(uuid, text, text) from public, anon;
revoke all on function public.cancel_invite(uuid) from public, anon;
revoke all on function public.set_member_role(uuid, uuid, text) from public, anon;
revoke all on function public.remove_member(uuid, uuid) from public, anon;
revoke all on function public.rename_workspace(uuid, text) from public, anon;
revoke all on function public.delete_workspace(uuid) from public, anon;
grant execute on function public.is_free_domain(text) to authenticated, service_role;
grant execute on function public.my_email() to service_role;
grant execute on function public.ensure_workspace(uuid) to authenticated, service_role;
grant execute on function public.boot(uuid) to authenticated, service_role;
grant execute on function public.team(uuid) to authenticated, service_role;
grant execute on function public.invite_member(uuid, text, text) to authenticated, service_role;
grant execute on function public.cancel_invite(uuid) to authenticated, service_role;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.remove_member(uuid, uuid) to authenticated, service_role;
grant execute on function public.rename_workspace(uuid, text) to authenticated, service_role;
grant execute on function public.delete_workspace(uuid) to authenticated, service_role;
