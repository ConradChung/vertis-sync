-- supabase/tests/lume_alerts_test.sql
-- Grok Bot operator layer (Phase G4): the durable alert feed every notification lands in.
begin;
select plan(26);

-- structure
select has_table('public', 'lume_alerts', 'lume_alerts exists');
select col_is_pk('public', 'lume_alerts', 'id', 'lume_alerts.id is the primary key');
select col_type_is('public', 'lume_alerts', 'id', 'uuid', 'lume_alerts.id is uuid');
select col_not_null('public', 'lume_alerts', 'source', 'source is required');
select col_not_null('public', 'lume_alerts', 'title', 'title is required');
select col_default_is('public', 'lume_alerts', 'severity', 'info', 'severity defaults to info');
select has_column('public', 'lume_alerts', 'acked_by_operator', 'acked_by_operator exists');
select fk_ok('public', 'lume_alerts', 'acked_by_operator', 'public', 'lume_operators', 'id', 'acked_by_operator references lume_operators');
select has_index('public', 'lume_alerts', 'lume_alerts_unacked_idx', 'index on (acked_at, created_at desc)');
select col_is_unique('public', 'lume_alerts', 'dedupe_key', 'dedupe_key is unique');

-- RLS / grants: service role writes, owner reads (like events), Realtime like events
select ok((select relrowsecurity from pg_class where oid = 'public.lume_alerts'::regclass), 'lume_alerts has RLS on');
select ok(exists(select 1 from pg_policies where tablename = 'lume_alerts' and cmd = 'SELECT'
  and 'authenticated' = any(roles) and qual like '%lume_is_owner%'), 'owner-only select policy for authenticated');
select ok(not has_table_privilege('anon', 'public.lume_alerts', 'select'), 'anon cannot read lume_alerts');
select ok(not has_table_privilege('authenticated', 'public.lume_alerts', 'insert'), 'authenticated cannot insert');
select ok(not has_table_privilege('authenticated', 'public.lume_alerts', 'update'), 'authenticated cannot update');
select ok(has_table_privilege('service_role', 'public.lume_alerts', 'insert'), 'service_role can insert');
select ok(exists(select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'lume_alerts'),
  'lume_alerts is in the supabase_realtime publication');

-- behaviour
select lives_ok($$insert into lume_alerts (id, source, title) values
  ('00000000-0000-0000-0000-0000000a1e01', 'pgtap', 'hello')$$, 'a minimal alert inserts');
select is((select severity from lume_alerts where id = '00000000-0000-0000-0000-0000000a1e01'), 'info', 'severity default applied');
select ok((select created_at is not null and acked_at is null from lume_alerts where id = '00000000-0000-0000-0000-0000000a1e01'),
  'created_at set, acked_at null');
select throws_ok($$insert into lume_alerts (source, title, severity) values ('pgtap', 't', 'critical')$$,
  '23514', null, 'severity rejects unknown values');
select throws_ok($$insert into lume_alerts (source, title, scope) values ('pgtap', 't', 'nope')$$,
  '23514', null, 'scope rejects unknown values');
select lives_ok($$insert into lume_alerts (source, title, severity, scope) values ('pgtap', 't', 'urgent', 'validation')$$,
  'urgent + a known scope inserts');
select lives_ok($$insert into lume_alerts (source, title, dedupe_key) values ('pgtap', 'gate', 'pgtap:gate:1');
  insert into lume_alerts (source, title, dedupe_key) values ('pgtap', 'gate again', 'pgtap:gate:1')
  on conflict (dedupe_key) do nothing$$, 'a repeated dedupe_key with on conflict do nothing is a no-op');
select is((select count(*)::int from lume_alerts where dedupe_key = 'pgtap:gate:1'), 1, 'one row per dedupe_key');
select throws_ok($$insert into lume_alerts (source, title) values ('pgtap', null)$$,
  '23502', null, 'title cannot be null');

select * from finish();
rollback;
