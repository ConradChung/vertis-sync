-- supabase/tests/lume_core_test.sql
begin;
select plan(24);

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
select ok((select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename in ('events','pending_actions','agent_runs')) = 3, 'three lume tables are in supabase_realtime');

-- RLS + policies
select ok((select relrowsecurity from pg_class where relname='events'), 'events has RLS on');
select ok((select relrowsecurity from pg_class where relname='pending_actions'), 'pending_actions has RLS on');
select ok((select relrowsecurity from pg_class where relname='agent_runs'), 'agent_runs has RLS on');
select ok((select relrowsecurity from pg_class where relname='rotation_rules'), 'rotation_rules has RLS on');
select ok((select relrowsecurity from pg_class where relname='lume_campaigns'), 'lume_campaigns has RLS on');
select ok((select relrowsecurity from pg_class where relname='lume_external_schedules'), 'lume_external_schedules has RLS on');
select policies_are('public', 'events', array['events_auth_read'], 'events has only the owner read policy');

-- behaviour: check constraints
select throws_ok($$insert into pending_actions (kind) values ('nope')$$, '23514', null, 'pending_actions.kind rejects unknown kinds');
select throws_ok($$insert into pending_actions (kind, claim_status) values ('decide_gate', 'x')$$, '23514', null, 'pending_actions.claim_status rejects unknown values');
select lives_ok($$insert into pending_actions (kind, status) values ('decide_gate', 'executing')$$, 'pending_actions.status accepts executing');

-- behaviour: webhook dedupe
insert into events (type, title, webhook_id) values ('reply', 'first', 'wh_test_1')
  on conflict (webhook_id) where webhook_id is not null do nothing;
insert into events (type, title, webhook_id) values ('reply', 'replay', 'wh_test_1')
  on conflict (webhook_id) where webhook_id is not null do nothing;
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
