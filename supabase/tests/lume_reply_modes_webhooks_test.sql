-- pgTAP: inbox manager 3e + 3f (migration lume_reply_modes_webhooks):
--   decided_via accepts grant and client, still refuses anything else;
--   lume_campaign_reply_modes (owner | client | auto, service role only);
--   lume_vertical_webhooks (https only, secret length, cascade, service role only).
-- Everything rolls back.
begin;
select plan(17);

insert into public.pending_actions(id, kind, payload, requested_by)
  values ('00000000-0000-0000-0000-0000000e3e01', 'send_reply', '{"summary":"t","reply_to_uuid":"pgtap-3e","eaccount":"a@x.com","body":"hi"}', 'agent');
select lives_ok(
  $$update public.pending_actions set decided_via = 'grant', status = 'approved', claim_status = 'claimed' where id = '00000000-0000-0000-0000-0000000e3e01'$$,
  'decided_via grant is accepted');
select lives_ok(
  $$update public.pending_actions set decided_via = 'client' where id = '00000000-0000-0000-0000-0000000e3e01'$$,
  'decided_via client is accepted (3g)');
select throws_ok(
  $$update public.pending_actions set decided_via = 'slack' where id = '00000000-0000-0000-0000-0000000e3e01'$$,
  '23514', null, 'any other decided_via is refused');

select has_table('public', 'lume_campaign_reply_modes', 'lume_campaign_reply_modes exists');
select col_is_pk('public', 'lume_campaign_reply_modes', 'campaign_id', 'one mode per campaign');
select lives_ok($$insert into public.lume_campaign_reply_modes(campaign_id) values ('pgtap-camp-1')$$, 'a campaign row');
select is((select mode from public.lume_campaign_reply_modes where campaign_id = 'pgtap-camp-1'), 'owner', 'the default mode is owner');
select throws_ok($$insert into public.lume_campaign_reply_modes(campaign_id, mode) values ('pgtap-camp-2', 'everyone')$$, '23514', null, 'mode is owner, client or auto');
select throws_ok($$insert into public.lume_campaign_reply_modes(campaign_id, mode) values ('bad id!', 'auto')$$, '23514', null, 'campaign ids are checked');
select ok(not has_table_privilege('authenticated', 'public.lume_campaign_reply_modes', 'select'), 'no direct read for authenticated');
select ok(not has_table_privilege('anon', 'public.lume_campaign_reply_modes', 'insert'), 'no direct write for anon');

insert into public.lume_verticals(id, name) values ('00000000-0000-0000-0000-0000000e3f01', 'pgtap 3f vertical');
select lives_ok(
  $$insert into public.lume_vertical_webhooks(vertical_id, url, secret) values ('00000000-0000-0000-0000-0000000e3f01', 'https://example.com/hook', repeat('s', 32))$$,
  'a webhook per vertical');
select throws_ok(
  $$update public.lume_vertical_webhooks set url = 'http://example.com/hook' where vertical_id = '00000000-0000-0000-0000-0000000e3f01'$$,
  '23514', null, 'https only');
select throws_ok(
  $$update public.lume_vertical_webhooks set secret = 'short' where vertical_id = '00000000-0000-0000-0000-0000000e3f01'$$,
  '23514', null, 'the secret is at least 16 characters');
select ok(not has_table_privilege('authenticated', 'public.lume_vertical_webhooks', 'select'), 'the secret is not readable by authenticated');
select ok(not has_table_privilege('anon', 'public.lume_vertical_webhooks', 'select'), 'the secret is not readable by anon');
delete from public.lume_verticals where id = '00000000-0000-0000-0000-0000000e3f01';
select is((select count(*)::int from public.lume_vertical_webhooks where vertical_id = '00000000-0000-0000-0000-0000000e3f01'), 0, 'deleting the vertical removes its webhook');

select * from finish();
rollback;
