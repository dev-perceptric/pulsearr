-- Team tests (004_team.sql): first sign-in makes a workspace named after the company, invites join the right
-- workspace by email, and roles hold: members can't manage the team, nobody removes the owner, only the owner
-- deletes the workspace.
\set ON_ERROR_STOP on
set client_min_messages = warning;
\o /dev/null

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'TEAM TEST FAILED: %', what; end if;
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
-- Saved values, readable by the authenticated role.
create temp table v (name text primary key, id uuid);
grant all on v to authenticated;
create function pg_temp.v(n text) returns uuid language sql as $$ select id from v where name = n $$;

insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-0000000000e1', 'a@acme.com'),
  ('b0000000-0000-0000-0000-0000000000e1', 'g@gmail.com'),
  ('c0000000-0000-0000-0000-0000000000e1', 'new@acme.com'),
  ('d0000000-0000-0000-0000-0000000000e1', 'mem@acme.com'),
  ('e0000000-0000-0000-0000-0000000000e1', 'x@sub.example.co.uk');

-- First sign-in ------------------------------------------------------------------------------------------------
select pg_temp.as_user('a0000000-0000-0000-0000-0000000000e1', 'a@acme.com');
set role authenticated;
insert into v select 'acme', ensure_workspace();
select pg_temp.check(ensure_workspace() = pg_temp.v('acme'), 'a second sign-in made another workspace');
select pg_temp.check((select name from workspaces where id = pg_temp.v('acme')) = 'Acme', 'acme.com didn''t make "Acme"');
select pg_temp.check((select role from workspace_members where workspace_id = pg_temp.v('acme')) = 'owner', 'the first person isn''t the owner');
select pg_temp.check((select email from workspace_members where workspace_id = pg_temp.v('acme')) = 'a@acme.com', 'the member''s email wasn''t saved');
reset role;
select pg_temp.check((select created_by from workspaces where id = pg_temp.v('acme')) = 'a0000000-0000-0000-0000-0000000000e1', 'created_by isn''t set');

select pg_temp.as_user('b0000000-0000-0000-0000-0000000000e1', 'G@Gmail.com');
set role authenticated;
insert into v select 'gmail', ensure_workspace();
select pg_temp.check((select name from workspaces where id = pg_temp.v('gmail')) = 'My workspace', 'a gmail address didn''t make "My workspace"');
select pg_temp.check((select email from workspace_members where workspace_id = pg_temp.v('gmail')) = 'g@gmail.com', 'the email wasn''t lowercased');
reset role;

select pg_temp.as_user('e0000000-0000-0000-0000-0000000000e1', 'x@sub.example.co.uk');
set role authenticated;
insert into v select 'sub', ensure_workspace();
select pg_temp.check((select name from workspaces where id = pg_temp.v('sub')) = 'Sub', 'the first label of the domain isn''t the name');
reset role;

-- Not signed in.
select pg_temp.as_user('', '');
set role authenticated;
select pg_temp.check(pg_temp.err('select ensure_workspace()') = 'Not signed in', 'ensure_workspace works signed out');
reset role;

-- Invites --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('a0000000-0000-0000-0000-0000000000e1', 'a@acme.com');
set role authenticated;
insert into v select 'inv', invite_member(pg_temp.v('acme'), '  New@Acme.com ', 'member');
select pg_temp.check((select email from invites where id = pg_temp.v('inv')) = 'new@acme.com', 'the invite email wasn''t trimmed and lowercased');
select pg_temp.check(invite_member(pg_temp.v('acme'), 'new@acme.com', 'admin') = pg_temp.v('inv'), 'inviting again made a second invite');
select pg_temp.check((select role from invites where id = pg_temp.v('inv')) = 'admin', 'inviting again didn''t change the role');
select pg_temp.check((select jsonb_array_length(team(pg_temp.v('acme'))->'invites')) = 1, 'the owner doesn''t see the invite in team()');
select pg_temp.check((select team(pg_temp.v('acme'))->'invites'->0 ?& array['id', 'email', 'role', 'created_at']), 'an invite in team() is missing fields');
select pg_temp.check((select team(pg_temp.v('acme'))->'members'->0 ?& array['user_id', 'email', 'role', 'created_at']), 'a member in team() is missing fields');
select pg_temp.check(pg_temp.err($q$select invite_member('$q$ || pg_temp.v('acme') || $q$', 'a@acme.com')$q$) = 'Already on the team', 'inviting a member didn''t say they''re on the team');
select pg_temp.check(pg_temp.err($q$select invite_member('$q$ || pg_temp.v('acme') || $q$', 'not an email')$q$) = 'Enter a valid email', 'a bad email was invited');
select pg_temp.check(pg_temp.err($q$select invite_member('$q$ || pg_temp.v('acme') || $q$', 'x@acme.com', 'owner')$q$) = 'Pick admin or member', 'someone was invited as owner');
-- A second invite for Mem.
select invite_member(pg_temp.v('acme'), 'mem@acme.com');
reset role;
-- Each invite queued one invite email, keyed by the invite (the two adds for New collapsed into one).
select pg_temp.check((select count(*) from jobs where kind = 'email.invite' and key = pg_temp.v('inv')::text and status = 'queued') = 1, 'the invite email wasn''t queued once');
select pg_temp.check((select payload->>'email' = 'new@acme.com' and payload->>'role' = 'admin' and payload->>'workspace_id' = pg_temp.v('acme')::text
  from jobs where key = pg_temp.v('inv')::text), 'the invite email job has the wrong payload');
select pg_temp.check((select count(*) from jobs where kind = 'email.invite') = 2, 'the wrong number of invite emails was queued');

-- The invitee signs in (their token's email in another case) and lands in Acme, without a workspace of their own.
select pg_temp.as_user('c0000000-0000-0000-0000-0000000000e1', 'NEW@acme.com');
set role authenticated;
select pg_temp.check(ensure_workspace() = pg_temp.v('acme'), 'the invitee didn''t join Acme');
select pg_temp.check((select count(*) from workspaces) = 1, 'the invitee got a workspace of their own too');
select pg_temp.check((select role from workspace_members where workspace_id = pg_temp.v('acme') and user_id = 'c0000000-0000-0000-0000-0000000000e1') = 'admin', 'the invitee didn''t get the invited role');
reset role;
select pg_temp.check(not exists (select 1 from invites where id = pg_temp.v('inv')), 'the accepted invite wasn''t deleted');

-- Mem joins as a member.
select pg_temp.as_user('d0000000-0000-0000-0000-0000000000e1', 'mem@acme.com');
set role authenticated;
select pg_temp.check(ensure_workspace() = pg_temp.v('acme'), 'Mem didn''t join Acme');
-- Members can't manage the team.
select pg_temp.check(pg_temp.err($q$select invite_member('$q$ || pg_temp.v('acme') || $q$', 'friend@acme.com')$q$) = 'Not allowed', 'a member invited someone');
select pg_temp.check(pg_temp.err($q$select set_member_role('$q$ || pg_temp.v('acme') || $q$', 'd0000000-0000-0000-0000-0000000000e1', 'admin')$q$) = 'Not allowed', 'a member made themselves admin');
select pg_temp.check(pg_temp.err($q$select remove_member('$q$ || pg_temp.v('acme') || $q$', 'c0000000-0000-0000-0000-0000000000e1')$q$) = 'Not allowed', 'a member removed someone');
select pg_temp.check(pg_temp.err($q$select rename_workspace('$q$ || pg_temp.v('acme') || $q$', 'Mine')$q$) = 'Not allowed', 'a member renamed the workspace');
select pg_temp.check(pg_temp.err($q$select delete_workspace('$q$ || pg_temp.v('acme') || $q$')$q$) = 'Not allowed', 'a member deleted the workspace');
select pg_temp.check((select jsonb_array_length(team(pg_temp.v('acme'))->'members')) = 3, 'a member doesn''t see the team');
reset role;

-- The admin (New) ----------------------------------------------------------------------------------------------
select pg_temp.as_user('c0000000-0000-0000-0000-0000000000e1', 'new@acme.com');
set role authenticated;
select pg_temp.check(pg_temp.err($q$select remove_member('$q$ || pg_temp.v('acme') || $q$', 'a0000000-0000-0000-0000-0000000000e1')$q$) = 'The owner can''t be removed', 'an admin removed the owner');
select pg_temp.check(pg_temp.err($q$select set_member_role('$q$ || pg_temp.v('acme') || $q$', 'a0000000-0000-0000-0000-0000000000e1', 'member')$q$) = 'The owner''s role can''t be changed', 'an admin changed the owner''s role');
select pg_temp.check(pg_temp.err($q$select delete_workspace('$q$ || pg_temp.v('acme') || $q$')$q$) = 'Not allowed', 'an admin deleted the workspace');
select pg_temp.check(pg_temp.err($q$select rename_workspace('$q$ || pg_temp.v('acme') || $q$', '   ')$q$) = 'Use a name of 1 to 80 characters', 'a blank name was saved');
select pg_temp.check(pg_temp.err($q$select rename_workspace('$q$ || pg_temp.v('acme') || $q$', repeat('x', 81))$q$) = 'Use a name of 1 to 80 characters', 'an 81-character name was saved');
select rename_workspace(pg_temp.v('acme'), '  Acme Inc  ');
select pg_temp.check((select name from workspaces where id = pg_temp.v('acme')) = 'Acme Inc', 'an admin couldn''t rename');
select set_member_role(pg_temp.v('acme'), 'd0000000-0000-0000-0000-0000000000e1', 'admin');
select pg_temp.check((select role from workspace_members where user_id = 'd0000000-0000-0000-0000-0000000000e1') = 'admin', 'an admin couldn''t change a role');
select set_member_role(pg_temp.v('acme'), 'd0000000-0000-0000-0000-0000000000e1', 'member');
select pg_temp.check(pg_temp.err($q$select set_member_role('$q$ || pg_temp.v('acme') || $q$', 'b0000000-0000-0000-0000-0000000000e1', 'admin')$q$) = 'Not on the team', 'a role was set for someone not on the team');
-- Invite and cancel.
insert into v select 'inv2', invite_member(pg_temp.v('acme'), 'later@acme.com');
select cancel_invite(pg_temp.v('inv2'));
select pg_temp.check(not exists (select 1 from invites where id = pg_temp.v('inv2')), 'an admin couldn''t cancel an invite');
select cancel_invite(pg_temp.v('inv2')); -- already gone: fine
reset role;

-- The owner (A) ------------------------------------------------------------------------------------------------
select pg_temp.as_user('a0000000-0000-0000-0000-0000000000e1', 'a@acme.com');
set role authenticated;
select pg_temp.check(pg_temp.err($q$select remove_member('$q$ || pg_temp.v('acme') || $q$', 'a0000000-0000-0000-0000-0000000000e1')$q$) = 'The owner can''t leave the workspace', 'the owner removed themselves');
reset role;
-- Exactly one owner, even for direct writes by the server.
select pg_temp.check(pg_temp.err($q$update workspace_members set role = 'owner' where user_id = 'd0000000-0000-0000-0000-0000000000e1'$q$) like 'duplicate key%', 'a workspace got two owners');

-- Leaving and removing.
select pg_temp.as_user('d0000000-0000-0000-0000-0000000000e1', 'mem@acme.com');
set role authenticated;
select remove_member(pg_temp.v('acme'), 'd0000000-0000-0000-0000-0000000000e1');
select pg_temp.check(not is_member(pg_temp.v('acme')), 'a member couldn''t leave');
-- Signing in again after leaving: no invite left, so Mem gets a workspace of their own.
select pg_temp.check(ensure_workspace() <> pg_temp.v('acme'), 'leaving didn''t stick');
reset role;
select pg_temp.as_user('a0000000-0000-0000-0000-0000000000e1', 'a@acme.com');
set role authenticated;
select remove_member(pg_temp.v('acme'), 'c0000000-0000-0000-0000-0000000000e1');
select pg_temp.check((select count(*) from workspace_members where workspace_id = pg_temp.v('acme')) = 1, 'the owner couldn''t remove an admin');

-- p_pref: G is invited to Acme; signing in with their own workspace picked joins Acme and opens the pick.
select invite_member(pg_temp.v('acme'), 'g@gmail.com');
reset role;
select pg_temp.as_user('b0000000-0000-0000-0000-0000000000e1', 'g@gmail.com');
set role authenticated;
select pg_temp.check(ensure_workspace(pg_temp.v('gmail')) = pg_temp.v('gmail'), 'the picked workspace didn''t win');
select pg_temp.check(is_member(pg_temp.v('acme')), 'the invite wasn''t accepted along the way');
select pg_temp.check(ensure_workspace() = pg_temp.v('acme'), 'with no pick, the newest workspace joined isn''t opened');
select pg_temp.check(ensure_workspace('99999999-0000-0000-0000-000000000000') = pg_temp.v('acme'), 'a pick you are not in was opened');
reset role;

-- Deleting: only the owner, and it takes members, invites and jobs with it.
select pg_temp.as_user('b0000000-0000-0000-0000-0000000000e1', 'g@gmail.com');
set role authenticated;
select pg_temp.check(pg_temp.err($q$select delete_workspace('$q$ || pg_temp.v('acme') || $q$')$q$) = 'Not allowed', 'a non-owner deleted the workspace');
reset role;
select pg_temp.as_user('a0000000-0000-0000-0000-0000000000e1', 'a@acme.com');
set role authenticated;
select invite_member(pg_temp.v('acme'), 'pending@acme.com');
select delete_workspace(pg_temp.v('acme'));
select pg_temp.check(not exists (select 1 from workspaces where id = pg_temp.v('acme')), 'the owner couldn''t delete the workspace');
reset role;
select pg_temp.check(not exists (select 1 from workspace_members where workspace_id = pg_temp.v('acme'))
  and not exists (select 1 from invites where workspace_id = pg_temp.v('acme'))
  and not exists (select 1 from jobs where workspace_id = pg_temp.v('acme')), 'deleting left members, invites or jobs behind');
select pg_temp.check(exists (select 1 from workspaces where id = pg_temp.v('gmail')), 'deleting took another workspace with it');

\o
select 'team tests passed' as result;
