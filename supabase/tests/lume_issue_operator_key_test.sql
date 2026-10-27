-- pgTAP: issue_operator_key pending-action kind (migration lume_issue_operator_key_kind).
begin;
select plan(5);
insert into public.pending_actions(kind, payload, requested_by)
  values ('issue_operator_key', '{"summary":"t","vertical_id":"v1"}', 'agent');
select pass('issue_operator_key is an allowed kind');
select throws_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('issue_operator_key', '{"summary":"t","vertical_id":"v1"}', 'agent')$$,
  '23505', null, 'a second awaiting key request for the same vertical is refused');
select lives_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('issue_operator_key', '{"summary":"t","vertical_id":"v2"}', 'agent')$$,
  'another vertical is allowed');
select lives_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('update_sequence', '{"summary":"t","campaign_id":"c-pgtap"}', 'agent')$$,
  'existing kinds are still allowed');
select throws_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('bogus_kind', '{"summary":"t"}', 'agent')$$,
  '23514', null, 'unknown kinds are still refused');
select * from finish();
rollback;
