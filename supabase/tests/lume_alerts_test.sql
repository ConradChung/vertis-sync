-- supabase/tests/lume_alerts_test.sql
-- Grok Bot operator layer (Phase G4): the durable alert feed every notification lands in.
begin;
select plan(48);

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

-- lume_alert_upsert (20261027 fix): one row per dedupe_key; a re-opened gate
-- comes back unacked. Modes: reopen (default) / update / touch.
select has_function('public', 'lume_alert_upsert', 'lume_alert_upsert exists');
select ok(not has_function_privilege('anon', 'public.lume_alert_upsert(text,text,text,text,text,text,text,text,text,boolean)', 'execute'), 'anon cannot call lume_alert_upsert');
select ok(not has_function_privilege('authenticated', 'public.lume_alert_upsert(text,text,text,text,text,text,text,text,text,boolean)', 'execute'), 'authenticated cannot call lume_alert_upsert');
select ok(has_function_privilege('service_role', 'public.lume_alert_upsert(text,text,text,text,text,text,text,text,text,boolean)', 'execute'), 'service_role can call lume_alert_upsert');

select isnt(lume_alert_upsert('pgtap', null, 'no key', null, null, null, null, null), null, 'no dedupe_key: inserts and returns the id');
select is((select severity from lume_alerts where title = 'no key'), 'info', 'a null severity defaults to info');
select lives_ok($$select lume_alert_upsert('pgtap', 'info', 'no key', null, null, null, null, null)$$, 'no dedupe_key twice inserts again');
select is((select count(*)::int from lume_alerts where title = 'no key'), 2, 'rows without a dedupe_key are never merged');

select lives_ok($$select lume_alert_upsert('pgtap', 'urgent', 'Gate v1', 'body v1', '/validate', 'c1', 'validation', 'pgtap:reopen')$$, 'first gate prompt inserts');
update lume_alerts set acked_at = now(), created_at = now() - interval '1 day' where dedupe_key = 'pgtap:reopen';
do $$ begin perform lume_alert_upsert('pgtap', 'urgent', 'Gate v2', 'body v2', '/validate', 'c1', 'validation', 'pgtap:reopen'); end $$;
select ok((select acked_at is null and title = 'Gate v2' and body = 'body v2' and created_at > now() - interval '1 minute'
  from lume_alerts where dedupe_key = 'pgtap:reopen'), 'reopen: unacked, content refreshed, created_at bumped');
select is((select count(*)::int from lume_alerts where dedupe_key = 'pgtap:reopen'), 1, 'reopen keeps one row per key');

do $$ begin perform lume_alert_upsert('pgtap', 'urgent', 'Gate v2', 'body v2', null, 'c2', 'campaign', 'pgtap:reopen'); end $$;
select ok((select campaign_id = 'c2' and scope = 'campaign' and link = '/validate' from lume_alerts where dedupe_key = 'pgtap:reopen'),
  'reopen: a given campaign / scope replaces the stored one; a null link keeps it');
do $$ begin perform lume_alert_upsert('lume.gates', 'urgent', 'ping', null, null, null, null, 'pgtap:reopen', 'touch'); end $$;
select ok((select campaign_id = 'c2' and scope = 'campaign' from lume_alerts where dedupe_key = 'pgtap:reopen'),
  'touch: null campaign / scope never erase the stored ones');

update lume_alerts set acked_at = now() where dedupe_key = 'pgtap:reopen';
do $$ begin perform lume_alert_upsert('pgtap', 'info', 'Gate closed', 'body v3', null, null, null, 'pgtap:reopen', 'update'); end $$;
select ok((select acked_at is not null and severity = 'info' and title = 'Gate closed' and link = '/validate' and scope = 'campaign'
  from lume_alerts where dedupe_key = 'pgtap:reopen'), 'update: content refreshed, ack kept, null link/scope keep the stored ones');

do $$ begin perform lume_alert_upsert('lume.gates', 'urgent', 'ping', 'ping body', '/validate?gate=x', null, null, 'pgtap:reopen', 'touch'); end $$;
select ok((select acked_at is null and title = 'Gate closed' and source = 'pgtap'
  from lume_alerts where dedupe_key = 'pgtap:reopen'), 'touch: unacked, the stored content kept');

select throws_ok($$select lume_alert_upsert('pgtap', 'info', 't', null, null, null, null, 'k', 'bogus')$$,
  '22023', null, 'an unknown mode is rejected');

-- owner_only (migration lume_alerts_owner_only)
select col_default_is('public', 'lume_alerts', 'owner_only', 'false', 'owner_only defaults to false');
select col_not_null('public', 'lume_alerts', 'owner_only', 'owner_only is not null');
select ok(not exists(select 1 from pg_proc where proname = 'lume_alert_upsert' and pronargs = 9), 'the 9-argument upsert is gone (no overloads)');
do $$ begin perform lume_alert_upsert('pgtap', 'info', 'plain', null, null, null, null, 'pgtap:owner-plain'); end $$;
select ok((select not owner_only from lume_alerts where dedupe_key = 'pgtap:owner-plain'), 'existing callers (no p_owner_only) write false');
do $$ begin perform lume_alert_upsert('pgtap', 'urgent', 'key', null, null, null, null, 'pgtap:owner', 'reopen', true); end $$;
select ok((select owner_only from lume_alerts where dedupe_key = 'pgtap:owner'), 'p_owner_only true is stored');
do $$ begin perform lume_alert_upsert('pgtap', 'info', 'key decided', null, null, null, null, 'pgtap:owner', 'update'); end $$;
select ok((select owner_only from lume_alerts where dedupe_key = 'pgtap:owner'), 'once owner-only, a later upsert without the flag keeps it');

select * from finish();
rollback;
