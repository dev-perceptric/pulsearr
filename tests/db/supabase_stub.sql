-- Just enough of Supabase (GoTrue's auth schema and PostgREST's roles) to run the migrations on a plain Postgres,
-- for tests. auth.uid() and auth.jwt() read the request settings PostgREST sets, as the real ones do: tests set
-- request.jwt.claims to '{"sub": "<user id>", "email": "...", "role": "authenticated"}' and then `set role`.
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
do $$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit bypassrls; exception when duplicate_object then null; end $$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
-- Supabase grants everything in public to these roles. Row level security and revokes do the limiting, so the
-- migrations must revoke what they don't want, and the tests prove they did.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
