-- boot() (004_team.sql): one call returns the person, the open workspace with their role, and every workspace
-- they're in by name. The picked workspace wins when they're in it; a new person gets one.
\set ON_ERROR_STOP on
set client_min_messages = warning;
\o /dev/null

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'BOOT TEST FAILED: %', what; end if;
end $$;
create function pg_temp.as_user(uid text, email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when coalesce(uid, '') = '' then '' else json_build_object('sub', uid, 'email', email, 'role', 'authenticated')::text end, false);
end $$;
create temp table got (who text primary key, out jsonb);
grant all on got to authenticated;
create function pg_temp.got(w text) returns jsonb language sql as $$ select out from got where who = w $$;

insert into auth.users (id, email) values
  ('a1000000-0000-0000-0000-0000000000b0', 'amy@bootco.com'),
  ('b1000000-0000-0000-0000-0000000000b0', 'bob@bootco.com'),
  ('d1000000-0000-0000-0000-0000000000b0', 'dee@newco.com');
insert into workspaces (id, name, created_at) values
  ('b0010000-0000-0000-0000-000000000000', 'Zeta', now() - interval '3 days'),
  ('b0020000-0000-0000-0000-000000000000', 'alpha', now() - interval '2 days'),
  ('b0030000-0000-0000-0000-000000000000', 'Elsewhere', now() - interval '1 day');
insert into workspace_members (workspace_id, user_id, role, email, created_at) values
  ('b0010000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-0000000000b0', 'owner', 'amy@bootco.com', now() - interval '3 days'),
  ('b0020000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-0000000000b0', 'admin', 'amy@bootco.com', now() - interval '2 days'),
  ('b0010000-0000-0000-0000-000000000000', 'b1000000-0000-0000-0000-0000000000b0', 'member', 'bob@bootco.com', now() - interval '3 days'),
  ('b0030000-0000-0000-0000-000000000000', 'b1000000-0000-0000-0000-0000000000b0', 'owner', 'bob@bootco.com', now() - interval '1 day');

select pg_temp.as_user('a1000000-0000-0000-0000-0000000000b0', 'amy@bootco.com');
set role authenticated;
insert into got select 'amy', boot();
insert into got select 'amy-pref', boot('b0010000-0000-0000-0000-000000000000');
insert into got select 'amy-other', boot('b0030000-0000-0000-0000-000000000000');
reset role;
select pg_temp.as_user('d1000000-0000-0000-0000-0000000000b0', 'dee@newco.com');
set role authenticated;
insert into got select 'dee', boot();
insert into got select 'dee-again', boot();
reset role;

-- Shape.
select pg_temp.check((select pg_temp.got('amy') ?& array['user', 'workspace', 'workspaces']), 'boot is missing user, workspace or workspaces');
select pg_temp.check((select pg_temp.got('amy')->'user' = jsonb_build_object('id', 'a1000000-0000-0000-0000-0000000000b0', 'email', 'amy@bootco.com')), 'user is wrong');
select pg_temp.check((select pg_temp.got('amy')->'workspace' ?& array['id', 'name', 'role']), 'workspace is missing id, name or role');
select pg_temp.check((select jsonb_typeof(pg_temp.got('amy')->'workspaces')) = 'array', 'workspaces isn''t a list');
select pg_temp.check((select pg_temp.got('amy')->'workspaces'->0 ?& array['id', 'name', 'role']), 'a listed workspace is missing id, name or role');
-- Amy: no pick opens the workspace she joined last; the list is by name, whatever the case.
select pg_temp.check((select pg_temp.got('amy')->'workspace'->>'id') = 'b0020000-0000-0000-0000-000000000000', 'no pick didn''t open the newest workspace joined');
select pg_temp.check((select pg_temp.got('amy')->'workspace'->>'role') = 'admin', 'the open workspace has the wrong role');
select pg_temp.check((select jsonb_array_length(pg_temp.got('amy')->'workspaces')) = 2, 'Amy doesn''t see exactly her two workspaces');
select pg_temp.check((select pg_temp.got('amy')->'workspaces'->0->>'name') = 'alpha' and (select pg_temp.got('amy')->'workspaces'->1->>'name') = 'Zeta', 'workspaces aren''t by name');
select pg_temp.check((select pg_temp.got('amy')->'workspaces'->1->>'role') = 'owner', 'a listed workspace has the wrong role');
-- The pick wins; a pick she isn't in is ignored and not listed.
select pg_temp.check((select pg_temp.got('amy-pref')->'workspace') = '{"id":"b0010000-0000-0000-0000-000000000000","name":"Zeta","role":"owner"}'::jsonb, 'the picked workspace didn''t open');
select pg_temp.check((select pg_temp.got('amy-other')->'workspace'->>'id') = 'b0020000-0000-0000-0000-000000000000', 'a workspace she isn''t in was opened');
select pg_temp.check((select not (pg_temp.got('amy-other')->'workspaces' @> '[{"name":"Elsewhere"}]')), 'a workspace she isn''t in was listed');
-- Dee is new: one workspace, hers, named after her company, the same on the second boot.
select pg_temp.check((select pg_temp.got('dee')->'workspace'->>'name') = 'Newco' and (select pg_temp.got('dee')->'workspace'->>'role') = 'owner', 'a new person didn''t get their own workspace');
select pg_temp.check((select jsonb_array_length(pg_temp.got('dee')->'workspaces')) = 1, 'a new person sees more than their workspace');
select pg_temp.check((select pg_temp.got('dee-again')->'workspace') = (select pg_temp.got('dee')->'workspace'), 'a second boot made another workspace');
select pg_temp.check((select count(*) from workspace_members where user_id = 'd1000000-0000-0000-0000-0000000000b0') = 1, 'Dee is in more than one workspace');

-- Signed out, and anon.
select pg_temp.as_user('', '');
set role authenticated;
do $$
begin
  perform boot();
  raise exception 'BOOT TEST FAILED: boot works without signing in';
exception when others then
  if sqlerrm like 'BOOT TEST FAILED%' then raise; end if;
end $$;
reset role;
select pg_temp.check(not has_function_privilege('anon', 'public.boot(uuid)', 'execute'), 'anon can call boot');
select pg_temp.check(has_function_privilege('authenticated', 'public.boot(uuid)', 'execute'), 'signed-in people can''t call boot');

\o
select 'boot tests passed' as result;
