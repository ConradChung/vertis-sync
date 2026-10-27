-- pgTAP: remove_leads pending-action kind + lume_cycled_leads (migration lume_remove_leads).
begin;
select plan(22);

-- kind
insert into public.rotation_rules(id, name, campaign_id, cron, kind, params)
  values ('00000000-0000-0000-0000-00000000c7aa', 'pgtap cycle', 'c-pgtap', '0 7 * * *', 'cycle_out', '{"after_days":14}');
insert into public.pending_actions(id, kind, payload, requested_by)
  values ('00000000-0000-0000-0000-00000000c701', 'remove_leads', '{"summary":"t","campaign_id":"c-pgtap"}', 'agent');
select pass('remove_leads is an allowed kind');
select throws_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('remove_leads', '{"summary":"t","campaign_id":"c-pgtap"}', 'agent')$$,
  '23505', null, 'a second awaiting removal for the same campaign is refused');
select lives_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('remove_leads', '{"summary":"t","campaign_id":"c-pgtap-2"}', 'agent')$$,
  'another campaign is allowed');
select lives_ok(
  $$insert into public.pending_actions(kind, payload, requested_by, rule_id) values ('remove_leads', '{"summary":"t","campaign_id":"c-pgtap"}', 'rule', '00000000-0000-0000-0000-00000000c7aa')$$,
  'a rule removal for the same campaign is separate (one per rule)');
select throws_ok(
  $$insert into public.pending_actions(kind, payload, requested_by, rule_id) values ('remove_leads', '{"summary":"t","campaign_id":"c-x"}', 'rule', '00000000-0000-0000-0000-00000000c7aa')$$,
  '23505', null, 'a second awaiting removal for the same rule is refused');
select lives_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('issue_operator_key', '{"summary":"t","vertical_id":"v-pgtap"}', 'agent')$$,
  'existing kinds are still allowed');
select throws_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('bogus_kind', '{"summary":"t"}', 'agent')$$,
  '23514', null, 'unknown kinds are still refused');

-- lume_cycled_leads structure
select has_table('public', 'lume_cycled_leads', 'lume_cycled_leads exists');
select col_is_pk('public', 'lume_cycled_leads', 'id', 'id is the primary key');
select col_not_null('public', 'lume_cycled_leads', 'campaign_id', 'campaign_id required');
select col_not_null('public', 'lume_cycled_leads', 'instantly_lead_id', 'instantly_lead_id required');
select col_not_null('public', 'lume_cycled_leads', 'snapshot', 'snapshot required');
select fk_ok('public', 'lume_cycled_leads', 'action_id', 'public', 'pending_actions', 'id', 'action_id references pending_actions');

-- RLS / grants
select ok((select relrowsecurity from pg_class where oid = 'public.lume_cycled_leads'::regclass), 'RLS on');
select ok(exists(select 1 from pg_policies where tablename = 'lume_cycled_leads' and cmd = 'SELECT'
  and 'authenticated' = any(roles) and qual like '%lume_is_owner%'), 'owner-only select policy');
select ok(not has_table_privilege('anon', 'public.lume_cycled_leads', 'select'), 'anon cannot read');
select ok(not has_table_privilege('authenticated', 'public.lume_cycled_leads', 'insert'), 'authenticated cannot insert');
select ok(has_table_privilege('service_role', 'public.lume_cycled_leads', 'insert'), 'service_role can insert');

-- behaviour
select lives_ok($$insert into lume_cycled_leads (campaign_id, instantly_lead_id, email, snapshot, reason, action_id)
  values ('c-pgtap', 'L1', 'a@x.com', '{"id":"L1"}', 'cap', '00000000-0000-0000-0000-00000000c701')$$, 'a snapshot inserts');
select throws_ok($$insert into lume_cycled_leads (campaign_id, instantly_lead_id, snapshot, action_id)
  values ('c-pgtap', 'L1', '{}', '00000000-0000-0000-0000-00000000c701')$$, '23505', null, 'one snapshot per lead per action');
select throws_ok($$insert into lume_cycled_leads (campaign_id, instantly_lead_id, email, snapshot) values ('c', 'L2', 'A@X.com', '{}')$$,
  '23514', null, 'email must be lowercase');
delete from public.pending_actions where id = '00000000-0000-0000-0000-00000000c701';
select ok((select action_id is null from lume_cycled_leads where instantly_lead_id = 'L1'), 'deleting the action keeps the snapshot');

select * from finish();
rollback;
