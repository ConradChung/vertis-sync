-- supabase/tests/lume_core_test.sql
begin;
select plan(9);
select has_table('public', 'events', 'events exists');
select has_table('public', 'pending_actions', 'pending_actions exists');
select has_table('public', 'agent_runs', 'agent_runs exists');
select has_table('public', 'rotation_rules', 'rotation_rules exists');
select has_table('public', 'lume_campaigns', 'lume_campaigns exists');
select has_table('public', 'lume_external_schedules', 'lume_external_schedules exists');
select col_has_check('public', 'pending_actions', 'claim_status', 'pending_actions.claim_status is a claim slot');
select ok((select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename in ('events','pending_actions','agent_runs')) = 3, 'three lume tables are in supabase_realtime');
select ok((select relrowsecurity from pg_class where relname='events'), 'events has RLS on');
select * from finish();
rollback;
