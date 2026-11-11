-- PulseARR migration 001: the ops schema.
-- ops.schema_migrations records each migration file the runner on the VPS has applied (one transaction per file,
-- from `main`). The runner creates this table too, so it stays `if not exists`. Nobody but the runner reads it.
-- gen_random_uuid() is built into Postgres 13 and later, so no extension is needed for ids.

create schema if not exists ops;
revoke all on schema ops from public, anon, authenticated;

create table if not exists ops.schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
revoke all on ops.schema_migrations from public, anon, authenticated;
