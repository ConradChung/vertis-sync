-- pgTAP: lume_set_reply_mode (migration lume_set_reply_mode): the mode and
-- its audit event in one transaction; a no-op logs nothing; bad input writes
-- nothing; service role only. Everything rolls back.
begin;
select plan(10);

select is((public.lume_set_reply_mode('pgtap-rm-1', 'auto', 'owner'))->>'from', 'owner', 'a campaign with no row starts as owner');
select is((select mode from public.lume_campaign_reply_modes where campaign_id = 'pgtap-rm-1'), 'auto', 'the mode is stored');
select is((select count(*)::int from public.events where type = 'lume.reply_mode_changed' and source_id = 'pgtap-rm-1'), 1, 'one audit event');
select is((select payload->>'to' from public.events where type = 'lume.reply_mode_changed' and source_id = 'pgtap-rm-1'), 'auto', 'the event names the change');
select is((public.lume_set_reply_mode('pgtap-rm-1', 'auto', 'owner'))->>'event_id', null, 'an unchanged mode returns no event');
select is((select count(*)::int from public.events where type = 'lume.reply_mode_changed' and source_id = 'pgtap-rm-1'), 1, 'and logs nothing');
select throws_ok($$select public.lume_set_reply_mode('pgtap-rm-1', 'everyone', 'owner')$$, 'P0001', 'bad_mode', 'an unknown mode is refused');
select throws_ok($$select public.lume_set_reply_mode('bad id!', 'auto', 'owner')$$, '23514', null, 'a bad campaign id is refused, nothing written');
select ok(not has_function_privilege('authenticated', 'public.lume_set_reply_mode(text,text,text)', 'execute'), 'authenticated cannot execute');
select ok(not has_function_privilege('anon', 'public.lume_set_reply_mode(text,text,text)', 'execute'), 'anon cannot execute');

select * from finish();
rollback;
