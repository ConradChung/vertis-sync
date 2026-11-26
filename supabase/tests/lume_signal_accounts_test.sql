-- supabase/tests/lume_signal_accounts_test.sql
-- 90-day plan, phase 3: signal_accounts (status + touches for the Signals inbox). Everything rolls back.
begin;
select plan(9);

select has_table('public', 'signal_accounts', 'signal_accounts exists');
select ok((select relrowsecurity from pg_class where oid = 'public.signal_accounts'::regclass), 'signal_accounts has RLS on');
select ok(not has_table_privilege('authenticated', 'public.signal_accounts', 'select'), 'authenticated cannot read it');
select ok(not has_table_privilege('anon', 'public.signal_accounts', 'select'), 'anon cannot read it');

insert into signal_accounts (account_key, company_name, domain) values ('d:acme.com', 'Acme PM', 'acme.com');
select is((select status from signal_accounts where account_key = 'd:acme.com'), 'new', 'a new account starts as new');
select is((select count(*)::int from signal_accounts where account_key = 'd:acme.com'
            and email_touched_at is null and linkedin_touched_at is null and call_touched_at is null), 1, 'and untouched');
select throws_ok($$insert into signal_accounts (account_key) values ('acme.com')$$, '23514', null, 'the key must carry its kind (d:, n: or r:)');
select throws_ok($$update signal_accounts set status = 'won' where account_key = 'd:acme.com'$$, '23514', null, 'status is one of new, working, replied, dropped');
select throws_ok($$insert into signal_accounts (account_key) values ('d:acme.com')$$, '23505', null, 'one row per account');

select * from finish();
rollback;
