-- Leak tests. Each check raises an error when someone can see or do what they shouldn't.
-- People: Ann owns Acme, Ben is a member of Acme, Cat owns Other, Ida is Cat's admin. Acme invited Dan; Other
-- invited Eve. Server-only tables hold one row each.
\set ON_ERROR_STOP on
set client_min_messages = warning;
\o /dev/null

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'LEAK TEST FAILED: %', what; end if;
end $$;
create function pg_temp.as_user(uid text, email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when coalesce(uid, '') = '' then '' else json_build_object('sub', uid, 'email', email, 'role', 'authenticated')::text end, false);
end $$;
-- The error a statement raises as the current role, or null when it works.
create function pg_temp.err(q text) returns text language plpgsql as $$
begin
  execute q;
  return null;
exception when others then
  return sqlerrm;
end $$;

insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'ann@acme.com'),
  ('b0000000-0000-0000-0000-000000000001', 'ben@acme.com'),
  ('c0000000-0000-0000-0000-000000000001', 'cat@other.com'),
  ('e0000000-0000-0000-0000-000000000001', 'ida@other.com');
insert into workspaces (id, name) values
  ('11111111-0000-0000-0000-000000000001', 'Acme'),
  ('22222222-0000-0000-0000-000000000001', 'Other');
insert into workspace_members (workspace_id, user_id, role, email) values
  ('11111111-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'owner', 'ann@acme.com'),
  ('11111111-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'member', 'ben@acme.com'),
  ('22222222-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'owner', 'cat@other.com'),
  ('22222222-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'admin', 'ida@other.com');
insert into invites (id, workspace_id, email, role) values
  ('1a000000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'dan@acme.com', 'member'),
  ('2a000000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', 'eve@other.com', 'admin');
insert into jobs (workspace_id, kind, key, payload) values ('22222222-0000-0000-0000-000000000001', 'email.invite', 'x', '{"secret":"cat"}');
insert into ai_cache (key, model, response) values ('k1', 'claude', '{"text":"cached"}');
insert into ai_usage (workspace_id, day, kind, count) values ('22222222-0000-0000-0000-000000000001', current_date, 'ask', 3);
insert into waitlist (email, source) values ('someone@example.com', 'site');
insert into rate_buckets (bucket, window_start, used) values ('waitlist:abc', now(), 1);

-- Every table in public has row level security on, and no API role may write any of them directly.
select pg_temp.check(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
), 'a table in public has row level security off');
select pg_temp.check(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace, unnest(array['anon', 'authenticated']) r(role),
    unnest(array['insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p(priv)
  where n.nspname = 'public' and c.relkind in ('r', 'v', 'm') and has_table_privilege(r.role, c.oid, p.priv)
), 'anon or authenticated can write a table directly');
select pg_temp.check(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'v', 'm') and has_table_privilege('anon', c.oid, 'select')
), 'anon can read a table');
-- anon can run no function in public; every security definer function pins its search_path.
select pg_temp.check(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
), 'anon can run a function in public');
select pg_temp.check(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
), 'a security definer function has no search_path');
-- The ops schema is the runner's alone.
select pg_temp.check(not has_schema_privilege('authenticated', 'ops', 'usage') and not has_schema_privilege('anon', 'ops', 'usage'),
  'API roles can use the ops schema');

-- Server-only tables and functions: closed to signed-in people, open to the server.
select pg_temp.check(not exists (
  select 1 from unnest(array['public.jobs', 'public.ai_cache', 'public.ai_usage', 'public.waitlist', 'public.rate_buckets']) t(name)
  where has_table_privilege('authenticated', t.name, 'select') or not has_table_privilege('service_role', t.name, 'select')
), 'a server-only table is readable by authenticated, or not by service_role');
select pg_temp.check(not exists (
  select 1 from unnest(array[
    'public.enqueue_job(uuid, text, text, jsonb, int, int)', 'public.claim_job(text[], text, int, int)',
    'public.extend_job(uuid, text, int)', 'public.finish_job(uuid, text, boolean, text, int, int)',
    'public.defer_job(uuid, text, int, jsonb)', 'public.prune_jobs()', 'public.take_rate(text, int, int)',
    'public.prune_rate_buckets()', 'public.use_ai(uuid, text, int)', 'public.add_to_waitlist(text, text, text)',
    'public.my_email()'
  ]) f(sig)
  where has_function_privilege('authenticated', f.sig, 'execute') or not has_function_privilege('service_role', f.sig, 'execute')
), 'a server-only function is callable by authenticated, or not by service_role');

-- Ann (owner of Acme) ----------------------------------------------------------------------------------------
select pg_temp.as_user('a0000000-0000-0000-0000-000000000001', 'ann@acme.com');
set role authenticated;
select pg_temp.check((select count(*) from workspaces) = 1, 'Ann sees a workspace that is not hers');
select pg_temp.check((select name from workspaces) = 'Acme', 'Ann does not see Acme');
select pg_temp.check((select count(*) from workspace_members) = 2, 'Ann sees members of another workspace');
select pg_temp.check(not exists (select 1 from workspace_members where workspace_id = '22222222-0000-0000-0000-000000000001'), 'Ann sees Other''s members');
select pg_temp.check((select count(*) from invites) = 1 and (select email from invites) = 'dan@acme.com', 'Ann sees invites of another workspace');
-- Server-only tables.
select pg_temp.check(pg_temp.err('select * from jobs') like 'permission denied%', 'authenticated can read jobs');
select pg_temp.check(pg_temp.err('select * from ai_cache') like 'permission denied%', 'authenticated can read ai_cache');
select pg_temp.check(pg_temp.err('select * from ai_usage') like 'permission denied%', 'authenticated can read ai_usage');
select pg_temp.check(pg_temp.err('select * from waitlist') like 'permission denied%', 'authenticated can read waitlist');
select pg_temp.check(pg_temp.err('select * from rate_buckets') like 'permission denied%', 'authenticated can read rate_buckets');
select pg_temp.check(pg_temp.err('select * from ops.schema_migrations') like 'permission denied%', 'authenticated can read ops.schema_migrations');
select pg_temp.check(pg_temp.err($q$select enqueue_job(null, 'email.invite', 'k', '{}')$q$) like 'permission denied%', 'authenticated can enqueue jobs');
select pg_temp.check(pg_temp.err($q$select * from claim_job(null, 'me')$q$) like 'permission denied%', 'authenticated can claim jobs');
select pg_temp.check(pg_temp.err($q$select add_to_waitlist('x@example.com')$q$) like 'permission denied%', 'authenticated can add to the waitlist');
select pg_temp.check(pg_temp.err($q$select use_ai('11111111-0000-0000-0000-000000000001', 'ask', 100)$q$) like 'permission denied%', 'authenticated can count AI use');
select pg_temp.check(pg_temp.err($q$select take_rate('b', 10, 60)$q$) like 'permission denied%', 'authenticated can take from a rate bucket');
-- Direct writes, even to her own workspace, are refused: writes go through the functions.
select pg_temp.check(pg_temp.err($q$insert into workspaces (name) values ('Sneaky')$q$) like 'permission denied%', 'Ann made a workspace directly');
select pg_temp.check(pg_temp.err($q$update workspaces set name = 'Renamed' where id = '11111111-0000-0000-0000-000000000001'$q$) like 'permission denied%', 'Ann renamed a workspace directly');
select pg_temp.check(pg_temp.err($q$delete from workspaces where id = '22222222-0000-0000-0000-000000000001'$q$) like 'permission denied%', 'Ann deleted a workspace directly');
select pg_temp.check(pg_temp.err($q$insert into workspace_members values ('22222222-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'admin', 'ann@acme.com')$q$) like 'permission denied%', 'Ann joined Other directly');
select pg_temp.check(pg_temp.err($q$update workspace_members set role = 'owner' where user_id = 'b0000000-0000-0000-0000-000000000001'$q$) like 'permission denied%', 'Ann changed a role directly');
select pg_temp.check(pg_temp.err($q$insert into invites (workspace_id, email) values ('22222222-0000-0000-0000-000000000001', 'x@y.com')$q$) like 'permission denied%', 'Ann made an invite directly');
-- The team functions on Other refuse her.
select pg_temp.check(pg_temp.err($q$select team('22222222-0000-0000-0000-000000000001')$q$) = 'Not allowed', 'Ann read Other''s team');
select pg_temp.check(pg_temp.err($q$select invite_member('22222222-0000-0000-0000-000000000001', 'spy@acme.com', 'admin')$q$) = 'Not allowed', 'Ann invited someone to Other');
select pg_temp.check(pg_temp.err($q$select cancel_invite('2a000000-0000-0000-0000-000000000001')$q$) = 'Not allowed', 'Ann cancelled Other''s invite');
select pg_temp.check(pg_temp.err($q$select set_member_role('22222222-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'member')$q$) = 'Not allowed', 'Ann changed a role in Other');
select pg_temp.check(pg_temp.err($q$select remove_member('22222222-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001')$q$) = 'Not allowed', 'Ann removed someone from Other');
select pg_temp.check(pg_temp.err($q$select rename_workspace('22222222-0000-0000-0000-000000000001', 'Pwned')$q$) = 'Not allowed', 'Ann renamed Other');
select pg_temp.check(pg_temp.err($q$select delete_workspace('22222222-0000-0000-0000-000000000001')$q$) = 'Not allowed', 'Ann deleted Other');
select pg_temp.check(not is_member('22222222-0000-0000-0000-000000000001') and not is_admin('22222222-0000-0000-0000-000000000001'), 'Ann counts as a member of Other');
-- boot() with Other as the pick opens Acme and doesn't list Other.
select pg_temp.check((select boot('22222222-0000-0000-0000-000000000001')->'workspace'->>'id') = '11111111-0000-0000-0000-000000000001', 'boot opened a workspace Ann is not in');
select pg_temp.check((select jsonb_array_length(boot()->'workspaces')) = 1, 'boot lists a workspace Ann is not in');
reset role;

-- Ben (member of Acme) ---------------------------------------------------------------------------------------
select pg_temp.as_user('b0000000-0000-0000-0000-000000000001', 'ben@acme.com');
set role authenticated;
select pg_temp.check((select count(*) from invites) = 0, 'a member sees invites');
select pg_temp.check((select jsonb_array_length(team('11111111-0000-0000-0000-000000000001')->'invites')) = 0, 'team() shows a member the invites');
select pg_temp.check((select jsonb_array_length(team('11111111-0000-0000-0000-000000000001')->'members')) = 2, 'team() doesn''t show a member the team');
select pg_temp.check(pg_temp.err($q$select cancel_invite('1a000000-0000-0000-0000-000000000001')$q$) = 'Not allowed', 'a member cancelled an invite');
reset role;

-- Someone signed in with an email Other invited, but a different account: the invite follows the email only.
-- Eve's invite is for eve@other.com; Mallory's token says mallory@evil.com, so she gets her own workspace.
insert into auth.users (id, email) values ('f0000000-0000-0000-0000-000000000001', 'mallory@evil.com');
select pg_temp.as_user('f0000000-0000-0000-0000-000000000001', 'mallory@evil.com');
set role authenticated;
select pg_temp.check((select boot()->'workspace'->>'name') = 'Evil', 'a new person didn''t get their own workspace');
select pg_temp.check((select count(*) from workspaces) = 1, 'a new person sees other workspaces');
reset role;

-- anon -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('', '');
set role anon;
select pg_temp.check(pg_temp.err('select * from workspaces') like 'permission denied%', 'anon can read workspaces');
select pg_temp.check(pg_temp.err('select * from workspace_members') like 'permission denied%', 'anon can read members');
select pg_temp.check(pg_temp.err('select * from invites') like 'permission denied%', 'anon can read invites');
select pg_temp.check(pg_temp.err('select boot()') like 'permission denied%', 'anon can call boot');
select pg_temp.check(pg_temp.err($q$select add_to_waitlist('x@example.com')$q$) like 'permission denied%', 'anon can add to the waitlist directly');
reset role;
-- Signed out but with the authenticated role: nothing.
set role authenticated;
select pg_temp.check((select count(*) from workspaces) = 0, 'no sign-in still sees workspaces');
select pg_temp.check(pg_temp.err('select boot()') = 'Not signed in', 'boot works without signing in');
reset role;

-- Nothing in Other changed.
select pg_temp.check((select name from workspaces where id = '22222222-0000-0000-0000-000000000001') = 'Other', 'Other was renamed');
select pg_temp.check((select count(*) from workspace_members where workspace_id = '22222222-0000-0000-0000-000000000001') = 2, 'Other''s members changed');
select pg_temp.check((select role from workspace_members where user_id = 'e0000000-0000-0000-0000-000000000001') = 'admin', 'Ida''s role changed');
select pg_temp.check((select count(*) from invites where workspace_id = '22222222-0000-0000-0000-000000000001') = 1, 'Other''s invites changed');
select pg_temp.check((select count(*) from jobs) = 1, 'a job was queued by someone who may not');

\o
select 'leak tests passed' as result;
