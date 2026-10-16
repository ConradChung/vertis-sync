-- supabase/tests/lume_core_test.sql
begin;
select plan(30);

-- structure
select has_table('public', 'events', 'events exists');
select has_table('public', 'pending_actions', 'pending_actions exists');
select has_table('public', 'agent_runs', 'agent_runs exists');
select has_table('public', 'rotation_rules', 'rotation_rules exists');
select has_table('public', 'lume_campaigns', 'lume_campaigns exists');
select has_table('public', 'lume_external_schedules', 'lume_external_schedules exists');
select col_has_check('public', 'pending_actions', 'claim_status', 'pending_actions.claim_status is a claim slot');
select has_column('public', 'events', 'webhook_id', 'events.webhook_id exists');
select has_column('public', 'pending_actions', 'executed_at', 'pending_actions.executed_at exists');
select has_index('public', 'events', 'events_webhook_id_idx', 'events has the webhook_id dedupe index');
-- Non-partial on purpose (20261015071538): PostgREST's upsert emits
-- `on conflict (webhook_id)` without a predicate, which cannot use a partial index.
select ok((select i.indpred is null from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'events_webhook_id_idx'),
          'events_webhook_id_idx is not partial');
select ok((select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename in ('events','pending_actions','agent_runs')) = 3, 'three lume tables are in supabase_realtime');

-- RLS + policies
select ok((select relrowsecurity from pg_class where relname='events'), 'events has RLS on');
select ok((select relrowsecurity from pg_class where relname='pending_actions'), 'pending_actions has RLS on');
select ok((select relrowsecurity from pg_class where relname='agent_runs'), 'agent_runs has RLS on');
select ok((select relrowsecurity from pg_class where relname='rotation_rules'), 'rotation_rules has RLS on');
select ok((select relrowsecurity from pg_class where relname='lume_campaigns'), 'lume_campaigns has RLS on');
select ok((select relrowsecurity from pg_class where relname='lume_external_schedules'), 'lume_external_schedules has RLS on');
select policies_are('public', 'events', array['events_auth_read'], 'events has only the owner read policy');

-- lume_is_owner(): the policies' gate
select ok((select proconfig @> array['search_path=pg_catalog, public'] from pg_proc where proname = 'lume_is_owner' and pronamespace = 'public'::regnamespace),
          'lume_is_owner() pins search_path, catalog first');
select ok(has_function_privilege('authenticated', 'lume_is_owner()', 'execute'), 'authenticated can execute lume_is_owner()');
select ok(not has_function_privilege('anon', 'lume_is_owner()', 'execute'), 'anon cannot execute lume_is_owner()');
-- every lume function pins the catalog first, so a public object can never shadow one
select is((select count(*)::int from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname like 'lume\_%'
              and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=public,%')),
          0, 'no lume_* function puts public before pg_catalog in search_path');
select is((select count(*)::int from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname like 'lume\_%'
              and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')),
          0, 'every lume_* function pins a search_path');

-- behaviour: check constraints
select throws_ok($$insert into pending_actions (kind) values ('nope')$$, '23514', null, 'pending_actions.kind rejects unknown kinds');
select throws_ok($$insert into pending_actions (kind, claim_status) values ('decide_gate', 'x')$$, '23514', null, 'pending_actions.claim_status rejects unknown values');
select lives_ok($$insert into pending_actions (kind, status) values ('decide_gate', 'executing')$$, 'pending_actions.status accepts executing');

-- behaviour: webhook dedupe
-- Plain `on conflict (webhook_id)`: the exact arbiter PostgREST emits for
-- `?on_conflict=webhook_id` (supabase-js upsert with ignoreDuplicates).
insert into events (type, title, webhook_id) values ('reply', 'first', 'wh_test_1')
  on conflict (webhook_id) do nothing;
insert into events (type, title, webhook_id) values ('reply', 'replay', 'wh_test_1')
  on conflict (webhook_id) do nothing;
select is((select count(*) from events where webhook_id = 'wh_test_1'), 1::bigint, 'duplicate webhook_id is dropped');

-- behaviour: atomic claim
insert into pending_actions (id, kind) values ('00000000-0000-0000-0000-00000000c1a1', 'decide_gate');
with c as (
  update pending_actions set claim_status = 'claimed'
   where id = '00000000-0000-0000-0000-00000000c1a1' and claim_status = 'awaiting' returning id)
select is((select count(*) from c), 1::bigint, 'first claim returns one row');
with c as (
  update pending_actions set claim_status = 'claimed'
   where id = '00000000-0000-0000-0000-00000000c1a1' and claim_status = 'awaiting' returning id)
select is((select count(*) from c), 0::bigint, 'second claim returns no row');

select * from finish();
rollback;
