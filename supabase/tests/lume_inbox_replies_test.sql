-- pgTAP: inbox manager 3a–3c (migration lume_inbox_replies):
--   one send_reply per inbound message (awaiting / approved / executing / executed),
--   lume_replies (positive replies, service role only),
--   lume_project_append_line (append-rule to a project note).
-- Everything rolls back.
begin;
select plan(24);

-- one reply per inbound ------------------------------------------------------
insert into public.pending_actions(id, kind, payload, requested_by, status, claim_status)
  values ('00000000-0000-0000-0000-0000000e1a01', 'send_reply',
          '{"summary":"t","reply_to_uuid":"pgtap-r1","eaccount":"a@x.com","body":"hi"}', 'agent', 'executed', 'claimed');
select throws_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('send_reply', '{"summary":"t","reply_to_uuid":"pgtap-r1","eaccount":"a@x.com","body":"again"}', 'agent')$$,
  '23505', null, 'a new reply to an inbound already answered (executed) is refused');
update public.pending_actions set status = 'approved' where id = '00000000-0000-0000-0000-0000000e1a01';
select throws_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('send_reply', '{"summary":"t","reply_to_uuid":"pgtap-r1","eaccount":"a@x.com","body":"again"}', 'agent')$$,
  '23505', null, 'refused while the first is approved');
update public.pending_actions set status = 'executing' where id = '00000000-0000-0000-0000-0000000e1a01';
select throws_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('send_reply', '{"summary":"t","reply_to_uuid":"pgtap-r1","eaccount":"a@x.com","body":"again"}', 'agent')$$,
  '23505', null, 'refused while the first is executing');
update public.pending_actions set status = 'failed' where id = '00000000-0000-0000-0000-0000000e1a01';
select lives_ok(
  $$insert into public.pending_actions(id, kind, payload, requested_by) values ('00000000-0000-0000-0000-0000000e1a02', 'send_reply', '{"summary":"t","reply_to_uuid":"pgtap-r1","eaccount":"a@x.com","body":"retry"}', 'agent')$$,
  'a failed send does not block a new attempt');
select throws_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('send_reply', '{"summary":"t","reply_to_uuid":"pgtap-r1","eaccount":"a@x.com","body":"third"}', 'agent')$$,
  '23505', null, 'refused while the retry awaits');
update public.pending_actions set status = 'rejected', claim_status = 'claimed' where id = '00000000-0000-0000-0000-0000000e1a02';
select lives_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('send_reply', '{"summary":"t","reply_to_uuid":"pgtap-r1","eaccount":"a@x.com","body":"after deny"}', 'agent')$$,
  'a denied draft does not block a new one');
select lives_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('send_reply', '{"summary":"t","reply_to_uuid":"pgtap-r2","eaccount":"a@x.com","body":"other"}', 'agent')$$,
  'another inbound message is independent');
select lives_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('pause_campaign', '{"summary":"t","campaign_id":"pgtap-c","reply_to_uuid":"pgtap-r2"}', 'agent')$$,
  'other kinds are not covered by the reply guard');
select ok(
  exists(select 1 from pg_indexes where tablename = 'pending_actions' and indexname = 'pending_actions_one_reply_per_inbound_idx'),
  'the guard index exists');

-- lume_replies ---------------------------------------------------------------
select has_table('public', 'lume_replies', 'lume_replies exists');
select col_is_pk('public', 'lume_replies', 'reply_to_uuid', 'one row per inbound message');
select lives_ok(
  $$insert into public.lume_replies(reply_to_uuid, campaign_id, lead_email, source, excerpt) values ('pgtap-r1', 'pgtap-c', 'lead@x.com', 'webhook', 'Sounds good')$$,
  'a positive reply is recorded');
select throws_ok(
  $$insert into public.lume_replies(reply_to_uuid, campaign_id, lead_email, source) values ('pgtap-r1', 'pgtap-c', 'lead@x.com', 'poll')$$,
  '23505', null, 'the same inbound message is recorded once');
select throws_ok(
  $$insert into public.lume_replies(reply_to_uuid, lead_email, source) values ('pgtap-r9', 'lead@x.com', 'telegram')$$,
  '23514', null, 'source is webhook or poll');
select throws_ok(
  $$insert into public.lume_replies(reply_to_uuid, lead_email, source, excerpt) values ('pgtap-r8', 'lead@x.com', 'poll', repeat('x', 2001))$$,
  '23514', null, 'the excerpt is capped at 2000 chars');
select ok((select relrowsecurity from pg_class where oid = 'public.lume_replies'::regclass), 'RLS is on');
select ok(not has_table_privilege('authenticated', 'public.lume_replies', 'select'), 'no direct read for authenticated');
select ok(not has_table_privilege('anon', 'public.lume_replies', 'select'), 'no direct read for anon');

-- lume_project_append_line ---------------------------------------------------
insert into public.agent_projects(id, name) values ('00000000-0000-0000-0000-0000000e1b01', 'pgtap inbox project');
select is(
  (public.lume_project_append_line('00000000-0000-0000-0000-0000000e1b01', 'voice-rules.md', '- Never say "circle back"'))->>'created',
  'true', 'a missing file is created as a note');
select is(
  (public.lume_project_append_line('00000000-0000-0000-0000-0000000e1b01', 'Voice-Rules.md', '- Sign off with "Conrad"'))->>'created',
  'false', 'the second rule appends to the same note (name match ignores case)');
select is(
  (select text_content from public.agent_project_files where project_id = '00000000-0000-0000-0000-0000000e1b01' and kind = 'note'),
  E'- Never say "circle back"\n- Sign off with "Conrad"', 'one line per rule, in order');
select is(
  (select size_bytes from public.agent_project_files where project_id = '00000000-0000-0000-0000-0000000e1b01' and kind = 'note'),
  octet_length(E'- Never say "circle back"\n- Sign off with "Conrad"')::bigint, 'size_bytes follows the text');
insert into public.agent_project_files(project_id, kind, name, storage_path, text_content)
  values ('00000000-0000-0000-0000-0000000e1b01', 'file', 'qualify-rules.md', 'pgtap/qualify-rules.md', 'uploaded');
select throws_ok(
  $$select public.lume_project_append_line('00000000-0000-0000-0000-0000000e1b01', 'qualify-rules.md', '- x')$$,
  'P0001', 'not_a_note', 'an uploaded file is never rewritten');
select throws_ok(
  $$select public.lume_project_append_line('00000000-0000-0000-0000-0000000e1bff', 'voice-rules.md', '- x')$$,
  'P0001', 'project_not_found', 'an unknown project is refused');

select * from finish();
rollback;
