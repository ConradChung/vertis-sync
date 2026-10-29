begin;
select plan(3);

select has_column('public', 'pending_actions', 'edited_by_slack_user', 'pending_actions records the Slack user who edited a reply');

insert into public.pending_actions(id, kind, payload, requested_by)
  values ('00000000-0000-0000-0000-0000000e3c03', 'send_reply', '{"summary":"t","reply_to_uuid":"pgtap-3g-edit","eaccount":"a@x.com","body":"hi"}', 'agent');
select lives_ok(
  $$update public.pending_actions set edited_by_slack_user = 'UPGTAPEDIT' where id = '00000000-0000-0000-0000-0000000e3c03'$$,
  'a Slack user id is stored');
select throws_ok(
  $$update public.pending_actions set edited_by_slack_user = 'not a user' where id = '00000000-0000-0000-0000-0000000e3c03'$$,
  '23514', null, 'edited_by_slack_user must be a Slack user id');

select * from finish();
rollback;
