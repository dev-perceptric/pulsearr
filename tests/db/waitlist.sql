-- The waitlist (007_waitlist.sql): one row per email, saved lowercased, bad emails refused, server only.
\set ON_ERROR_STOP on
set client_min_messages = warning;
\o /dev/null

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'WAITLIST TEST FAILED: %', what; end if;
end $$;
create function pg_temp.err(q text) returns text language plpgsql as $$
begin
  execute q;
  return null;
exception when others then
  return sqlerrm;
end $$;

set role service_role;
select pg_temp.check(add_to_waitlist('  Ana@Example.COM ', 'site', 'iphash1'), 'a new email wasn''t added');
select pg_temp.check(not add_to_waitlist('ana@example.com', 'other'), 'the same email was added twice');
select pg_temp.check(not add_to_waitlist('ANA@EXAMPLE.COM'), 'the same email in capitals was added again');
select pg_temp.check((select count(*) from waitlist) = 1, 'more than one row for one email');
select pg_temp.check((select email = 'ana@example.com' and source = 'site' and ip_hash = 'iphash1' and created_at is not null from waitlist),
  'the row wasn''t saved lowercased with its source, ip hash and time');
select pg_temp.check(add_to_waitlist('bo@example.com'), 'an email without a source wasn''t added');
select pg_temp.check((select source is null and ip_hash is null from waitlist where email = 'bo@example.com'), 'missing source or ip hash wasn''t left empty');
select pg_temp.check(add_to_waitlist('cy@example.com', '   ', ''), 'an email with a blank source wasn''t added');
select pg_temp.check((select source is null and ip_hash is null from waitlist where email = 'cy@example.com'), 'a blank source or ip hash was saved');
select pg_temp.check(add_to_waitlist('di@example.com', repeat('s', 300)), 'a long source wasn''t cut');
select pg_temp.check((select char_length(source) from waitlist where email = 'di@example.com') = 100, 'a long source wasn''t cut to 100');
select pg_temp.check(pg_temp.err($q$select add_to_waitlist('not an email')$q$) = 'Enter a valid email', 'a bad email was taken');
select pg_temp.check(pg_temp.err($q$select add_to_waitlist('a@b')$q$) = 'Enter a valid email', 'an email with no dot in the domain was taken');
select pg_temp.check(pg_temp.err($q$select add_to_waitlist(null)$q$) = 'Enter a valid email', 'no email was taken');
select pg_temp.check(pg_temp.err($q$select add_to_waitlist(repeat('a', 250) || '@example.com')$q$) = 'Enter a valid email', 'an over-long email was taken');
reset role;
-- Nobody but the server.
select pg_temp.check(not has_function_privilege('anon', 'public.add_to_waitlist(text, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.add_to_waitlist(text, text, text)', 'execute'), 'API roles can add to the waitlist');
select pg_temp.check(not has_table_privilege('anon', 'public.waitlist', 'select') and not has_table_privilege('authenticated', 'public.waitlist', 'select'),
  'API roles can read the waitlist');

\o
select 'waitlist tests passed' as result;
