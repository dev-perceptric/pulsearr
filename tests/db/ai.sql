-- AI limits and cache (006_ai.sql): use_ai counts calls per workspace, kind and day up to the limit; the tables
-- are the server's alone.
\set ON_ERROR_STOP on
set client_min_messages = warning;
\o /dev/null

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'AI TEST FAILED: %', what; end if;
end $$;

-- One transaction, so now() can't cross a window or day boundary between checks.
begin;
insert into workspaces (id, name) values
  ('a1a1a1a1-0000-0000-0000-000000000001', 'AI one'),
  ('a1a1a1a1-0000-0000-0000-000000000002', 'AI two');
set role service_role;
select pg_temp.check(use_ai('a1a1a1a1-0000-0000-0000-000000000001', 'pulse', 2), 'call 1 was refused');
select pg_temp.check(use_ai('a1a1a1a1-0000-0000-0000-000000000001', 'pulse', 2), 'call 2 was refused');
select pg_temp.check(not use_ai('a1a1a1a1-0000-0000-0000-000000000001', 'pulse', 2), 'call 3 went over the limit');
select pg_temp.check((select count from ai_usage where workspace_id = 'a1a1a1a1-0000-0000-0000-000000000001' and kind = 'pulse') = 2, 'a refused call was counted');
select pg_temp.check((select day from ai_usage where workspace_id = 'a1a1a1a1-0000-0000-0000-000000000001' and kind = 'pulse') = (now() at time zone 'utc')::date, 'usage isn''t counted on the UTC day');
-- Other kinds, other workspaces and other days count apart.
select pg_temp.check(use_ai('a1a1a1a1-0000-0000-0000-000000000001', 'ask', 2), 'another kind shared the limit');
select pg_temp.check(use_ai('a1a1a1a1-0000-0000-0000-000000000002', 'pulse', 2), 'another workspace shared the limit');
update ai_usage set day = day - 1 where workspace_id = 'a1a1a1a1-0000-0000-0000-000000000001' and kind = 'pulse';
select pg_temp.check(use_ai('a1a1a1a1-0000-0000-0000-000000000001', 'pulse', 2), 'a new day didn''t start fresh');
select pg_temp.check(not use_ai('a1a1a1a1-0000-0000-0000-000000000001', 'pulse', 0), 'a zero limit let a call through');
-- The cache is a plain table the server reads and writes.
insert into ai_cache (key, model, response) values ('step:abc', 'claude-sonnet', '{"text":"hi"}');
update ai_cache set hits = hits + 1, last_used_at = now() where key = 'step:abc';
select pg_temp.check((select hits = 1 and last_used_at is not null and created_at is not null from ai_cache where key = 'step:abc'), 'the cache row didn''t save');
reset role;
-- Deleting a workspace takes its usage with it.
delete from workspaces where id = 'a1a1a1a1-0000-0000-0000-000000000002';
select pg_temp.check(not exists (select 1 from ai_usage where workspace_id = 'a1a1a1a1-0000-0000-0000-000000000002'), 'usage outlived its workspace');
select pg_temp.check(not has_table_privilege('authenticated', 'public.ai_cache', 'select') and not has_table_privilege('authenticated', 'public.ai_usage', 'select')
  and not has_function_privilege('authenticated', 'public.use_ai(uuid, text, int)', 'execute'), 'signed-in people can use the AI tables');

commit;

\o
select 'ai tests passed' as result;
