-- pgTAP: migration lume_inbox_send_attempted.
--   A send_reply whose Instantly call was attempted (send_attempted) keeps
--   blocking a new reply to the same inbound email even after it failed or was
--   interrupted (it may have gone out). label_reply is a pending-action kind.
-- Everything rolls back.
begin;
select plan(9);

select has_column('public', 'pending_actions', 'send_attempted', 'pending_actions.send_attempted exists');
select col_default_is('public', 'pending_actions', 'send_attempted', 'false', 'defaults to false');

insert into public.pending_actions(id, kind, payload, requested_by, status, claim_status, send_attempted)
  values ('00000000-0000-0000-0000-0000000e2a01', 'send_reply',
          '{"summary":"t","reply_to_uuid":"pgtap-s1","eaccount":"a@x.com","body":"hi"}', 'agent', 'failed', 'claimed', true);
select throws_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('send_reply', '{"summary":"t","reply_to_uuid":"pgtap-s1","eaccount":"a@x.com","body":"again"}', 'agent')$$,
  '23505', null, 'a failed reply whose send was attempted still blocks a new one');
update public.pending_actions set status = 'expired' where id = '00000000-0000-0000-0000-0000000e2a01';
select throws_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('send_reply', '{"summary":"t","reply_to_uuid":"pgtap-s1","eaccount":"a@x.com","body":"again"}', 'agent')$$,
  '23505', null, 'any terminal row with send_attempted blocks');
update public.pending_actions set status = 'failed', send_attempted = false where id = '00000000-0000-0000-0000-0000000e2a01';
select lives_ok(
  $$insert into public.pending_actions(id, kind, payload, requested_by) values ('00000000-0000-0000-0000-0000000e2a02', 'send_reply', '{"summary":"t","reply_to_uuid":"pgtap-s1","eaccount":"a@x.com","body":"retry"}', 'agent')$$,
  'a failure before the send call does not block');
select throws_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('send_reply', '{"summary":"t","reply_to_uuid":"pgtap-s1","eaccount":"a@x.com","body":"third"}', 'agent')$$,
  '23505', null, 'awaiting still blocks');
update public.pending_actions set status = 'rejected', claim_status = 'claimed' where id = '00000000-0000-0000-0000-0000000e2a02';
select lives_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('send_reply', '{"summary":"t","reply_to_uuid":"pgtap-s1","eaccount":"a@x.com","body":"after deny"}', 'agent')$$,
  'a denied draft (never attempted) does not block');

select lives_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('label_reply', '{"summary":"t","reply_to_uuid":"pgtap-s2","category":"unsubscribe"}', 'agent')$$,
  'label_reply is an allowed kind');
select throws_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('bogus_kind', '{"summary":"t"}', 'agent')$$,
  '23514', null, 'unknown kinds are still refused');

select * from finish();
rollback;
