-- pgTAP: inbox manager 3g (migration lume_slack_client):
--   lume_slack_installs / _channels / _posts exist, are service role only,
--   check their ids, the encrypted-token format and the visible fields;
--   one post per (reply, workspace, channel); cascade on uninstall;
--   decided_via 'client' needs the Slack user and team.
-- Everything rolls back.
begin;
select plan(22);

select has_table('public', 'lume_slack_installs', 'lume_slack_installs exists');
select has_table('public', 'lume_slack_channels', 'lume_slack_channels exists');
select has_table('public', 'lume_slack_posts', 'lume_slack_posts exists');

select lives_ok(
  $$insert into public.lume_slack_installs(team_id, team_name, bot_user_id, bot_token_enc, installed_by) values ('TPGTAP01', 'pgtap ws', 'UPGTAPBOT', 'v1:abcDEF_-123', 'UPGTAPUSER')$$,
  'an install with an encrypted token');
select throws_ok(
  $$insert into public.lume_slack_installs(team_id, bot_user_id, bot_token_enc) values ('TPGTAP02', 'UPGTAPBOT', 'xoxb-plaintext-token')$$,
  '23514', null, 'a plaintext token is refused (only the v1: ciphertext format)');
select throws_ok(
  $$insert into public.lume_slack_installs(team_id, bot_user_id, bot_token_enc) values ('bad team', 'UPGTAPBOT', 'v1:abc')$$,
  '23514', null, 'team ids are checked');

insert into public.lume_verticals(id, name) values ('00000000-0000-0000-0000-0000000e3c01', 'pgtap 3g vertical');
select lives_ok(
  $$insert into public.lume_slack_channels(team_id, channel_id, channel_name, vertical_id, campaign_ids) values ('TPGTAP01', 'CPGTAP01', 'client-replies', '00000000-0000-0000-0000-0000000e3c01', array['camp-1'])$$,
  'a channel binding');
select is(
  (select cardinality(visible_fields) from public.lume_slack_channels where channel_id = 'CPGTAP01'), 9,
  'every lead-card field is visible by default');
select throws_ok(
  $$update public.lume_slack_channels set visible_fields = array['name', 'email'] where channel_id = 'CPGTAP01'$$,
  '23514', null, 'visible fields are only the known card fields');
select throws_ok(
  $$insert into public.lume_slack_channels(team_id, channel_id, vertical_id) values ('TPGTAP01', 'CPGTAP01', '00000000-0000-0000-0000-0000000e3c01')$$,
  '23505', null, 'one binding per (workspace, channel)');

select lives_ok(
  $$insert into public.lume_slack_posts(reply_to_uuid, team_id, channel_id) values ('pgtap-reply-1', 'TPGTAP01', 'CPGTAP01')$$,
  'a post claim (no ts yet)');
select throws_ok(
  $$insert into public.lume_slack_posts(reply_to_uuid, team_id, channel_id) values ('pgtap-reply-1', 'TPGTAP01', 'CPGTAP01')$$,
  '23505', null, 'one post per (reply, workspace, channel): the dedupe');
select lives_ok(
  $$update public.lume_slack_posts set ts = '1730000000.000100' where reply_to_uuid = 'pgtap-reply-1'$$,
  'the post ts is stored after chat.postMessage');
select throws_ok(
  $$update public.lume_slack_posts set ts = 'not-a-ts' where reply_to_uuid = 'pgtap-reply-1'$$,
  '23514', null, 'ts is a Slack message timestamp');

insert into public.pending_actions(id, kind, payload, requested_by)
  values ('00000000-0000-0000-0000-0000000e3c02', 'send_reply', '{"summary":"t","reply_to_uuid":"pgtap-3g","eaccount":"a@x.com","body":"hi"}', 'agent');
select throws_ok(
  $$update public.pending_actions set decided_via = 'client', status = 'approved', claim_status = 'claimed' where id = '00000000-0000-0000-0000-0000000e3c02'$$,
  '23514', null, 'decided_via client without the Slack user and team is refused');
select lives_ok(
  $$update public.pending_actions set decided_via = 'client', status = 'approved', claim_status = 'claimed', decided_by_slack_user = 'UPGTAPUSER', decided_by_slack_team = 'TPGTAP01' where id = '00000000-0000-0000-0000-0000000e3c02'$$,
  'decided_via client records the Slack user and team');
select lives_ok(
  $$update public.pending_actions set decided_via = 'lume' where id = '00000000-0000-0000-0000-0000000e3c02'$$,
  'other deciders do not need a Slack user');

select ok(not has_table_privilege('authenticated', 'public.lume_slack_installs', 'select'), 'tokens are not readable by authenticated');
select ok(not has_table_privilege('anon', 'public.lume_slack_installs', 'select'), 'tokens are not readable by anon');
select ok(not has_table_privilege('authenticated', 'public.lume_slack_channels', 'insert'), 'no direct channel writes for authenticated');
select ok(not has_table_privilege('anon', 'public.lume_slack_posts', 'select'), 'no direct post reads for anon');

delete from public.lume_slack_installs where team_id = 'TPGTAP01';
select is(
  (select count(*)::int from public.lume_slack_channels where team_id = 'TPGTAP01') + (select count(*)::int from public.lume_slack_posts where team_id = 'TPGTAP01'), 0,
  'deleting an install removes its channels and posts');

select * from finish();
rollback;
