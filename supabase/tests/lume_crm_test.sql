-- supabase/tests/lume_crm_test.sql
-- Lume CRM schema: tables, constraints, RLS + grants, crm_set_stage(),
-- lume_crm_followups / crm_followup_tick(), the pg_cron job, lume_overview()'s
-- crm_followups_due, the crm_close_deal pending-action kind, and
-- crm_backfill(dry_run). Uses its own campaign ids ('crm-test-*'); everything
-- rolls back.
begin;
select plan(40);

-- tables + RLS -----------------------------------------------------------------
select has_table('public', 'crm_stages', 'crm_stages exists');
select has_table('public', 'crm_deals', 'crm_deals exists');
select has_table('public', 'crm_activities', 'crm_activities exists');
select ok((select relrowsecurity from pg_class where oid = 'public.crm_deals'::regclass), 'crm_deals has RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.crm_activities'::regclass), 'crm_activities has RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.crm_stages'::regclass), 'crm_stages has RLS on');
select ok(not has_table_privilege('anon', 'public.crm_deals', 'select'), 'anon cannot read crm_deals');
select ok(not has_table_privilege('authenticated', 'public.crm_deals', 'insert'), 'authenticated cannot insert crm_deals');
select ok(not has_table_privilege('authenticated', 'public.crm_activities', 'update'), 'authenticated cannot update crm_activities');
select ok(exists (select 1 from pg_policies where tablename = 'crm_deals' and policyname = 'crm_deals_owner_read'
                  and qual like '%lume_is_owner%'), 'crm_deals read policy is owner-scoped');
select ok(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'crm_deals'),
          'crm_deals is in the realtime publication');

-- default stages ----------------------------------------------------------------
select is((select string_agg(name, ',' order by position) from crm_stages where campaign_id = '_default'),
          'Contacted,Replied,Interested,Meeting booked,Won,Lost,Bounced,Not now', 'default stages in order');
select is((select string_agg(name, ',' order by position) from crm_stages where campaign_id = '_default' and is_terminal),
          'Won,Lost,Bounced', 'Won, Lost, Bounced are terminal');

-- constraints ---------------------------------------------------------------------
insert into crm_deals (id, campaign_id, email, name) values
  ('00000000-0000-4000-8000-0000000000a1', 'crm-test-a', 'ada@example.com', 'Ada');
select throws_ok($$insert into crm_deals (campaign_id, email) values ('crm-test-a', 'ada@example.com')$$,
                 '23505', null, 'one deal per (campaign_id, email)');
select throws_ok($$insert into crm_deals (campaign_id, email) values ('crm-test-a', 'Mixed@Example.com')$$,
                 '23514', null, 'email must be lowercase');
select throws_ok($$insert into crm_activities (deal_id, kind, source) values ('00000000-0000-4000-8000-0000000000a1', 'called', 'user')$$,
                 '23514', null, 'activity kind is checked');
select throws_ok($$insert into crm_activities (deal_id, kind, source) values ('00000000-0000-4000-8000-0000000000a1', 'note', 'zapier')$$,
                 '23514', null, 'activity source is checked');
insert into crm_activities (deal_id, kind, source, dedupe_key) values ('00000000-0000-4000-8000-0000000000a1', 'replied', 'instantly', 'instantly:reply_received:x1');
select throws_ok($$insert into crm_activities (deal_id, kind, source, dedupe_key) values ('00000000-0000-4000-8000-0000000000a1', 'replied', 'instantly', 'instantly:reply_received:x1')$$,
                 '23505', null, 'dedupe_key is unique (a replayed webhook adds nothing)');

-- crm_set_stage --------------------------------------------------------------------
select has_function('public', 'crm_set_stage', 'crm_set_stage() exists');
select ok(not has_function_privilege('authenticated', 'public.crm_set_stage(uuid,text,text,text,jsonb)', 'execute'),
          'authenticated cannot execute crm_set_stage()');
select is(crm_set_stage('00000000-0000-4000-8000-0000000000a1', 'Replied', 'user'), 'Contacted', 'returns the previous stage');
select is((select stage from crm_deals where id = '00000000-0000-4000-8000-0000000000a1'), 'Replied', 'stage updated');
select is((select count(*)::int from crm_activities where deal_id = '00000000-0000-4000-8000-0000000000a1' and kind = 'stage_changed'
             and payload->>'from' = 'Contacted' and payload->>'to' = 'Replied' and source = 'user'), 1, 'stage_changed activity written');
select is(crm_set_stage('00000000-0000-4000-8000-0000000000a1', 'Replied', 'user'), 'Replied', 'same stage is a no-op');
select is((select count(*)::int from crm_activities where deal_id = '00000000-0000-4000-8000-0000000000a1' and kind = 'stage_changed'), 1,
          'a no-op writes no activity');
select throws_ok($$select crm_set_stage('00000000-0000-4000-8000-0000000000a1', 'Nonsense', 'user')$$, '22023', null, 'unknown stage refused');
select is(crm_set_stage('00000000-0000-4000-0000-000000000000', 'Replied', 'user'), null, 'missing deal → null');
select crm_set_stage('00000000-0000-4000-8000-0000000000a1', 'Lost', 'user', 'went with a competitor');
select is((select won_lost_reason from crm_deals where id = '00000000-0000-4000-8000-0000000000a1'), 'went with a competitor', 'Won/Lost reason stored');

-- follow-ups -------------------------------------------------------------------------
insert into crm_deals (id, campaign_id, email, stage, next_action, next_action_at) values
  ('00000000-0000-4000-8000-0000000000b1', 'crm-test-b', 'due@example.com', 'Interested', 'send deck', now() - interval '1 hour'),
  ('00000000-0000-4000-8000-0000000000b2', 'crm-test-b', 'later@example.com', 'Interested', 'call', now() + interval '1 day'),
  ('00000000-0000-4000-8000-0000000000b3', 'crm-test-b', 'won@example.com', 'Won', 'invoice', now() - interval '1 hour');
select is((select count(*)::int from lume_crm_followups where campaign_id = 'crm-test-b'), 1, 'only the past-due open deal is due');
select ok(not has_table_privilege('authenticated', 'public.lume_crm_followups', 'select'), 'authenticated cannot read lume_crm_followups');
select ok(crm_followup_tick() >= 1, 'crm_followup_tick() flags the due deal');
select is((select count(*)::int from events where type = 'lume.crm_followup_due' and source_id = '00000000-0000-4000-8000-0000000000b1'), 1,
          'one lume.crm_followup_due event for it');
select crm_followup_tick();
select is((select count(*)::int from events where type = 'lume.crm_followup_due' and source_id = '00000000-0000-4000-8000-0000000000b1'), 1,
          'a second tick does not flag it again');
select ok(((lume_overview())->>'crm_followups_due')::int >= 1, 'lume_overview() reports crm_followups_due');
select ok(exists (select 1 from cron.job where jobname = 'crm-followup-tick' and schedule = '*/15 * * * *' and active),
          'crm-followup-tick runs every 15 minutes');

-- crm_close_deal kind ------------------------------------------------------------------
select lives_ok($$insert into pending_actions (kind, payload, requested_by)
                  values ('crm_close_deal', '{"deal_id":"00000000-0000-4000-8000-0000000000b1","stage":"Won","summary":"x"}', 'user')$$,
                'crm_close_deal is an allowed pending-action kind');
select throws_ok($$insert into pending_actions (kind, payload, requested_by)
                   values ('crm_close_deal', '{"deal_id":"00000000-0000-4000-8000-0000000000b1","stage":"Lost","summary":"y"}', 'user')$$,
                 '23505', null, 'one awaiting crm_close_deal per deal');

-- backfill ---------------------------------------------------------------------------------
create temp table crm_t as select coalesce(sum(deals), 0)::int as total, (select count(*)::int from crm_deals) as deals_before from crm_backfill(true);
insert into lead_bank (campaign_id, email, state, pushed_at) values
  ('crm-test-c', 'bounced@example.com', 'bounced', now()),
  ('crm-test-c', 'queued@example.com', 'queued', now());
select is((select coalesce(sum(deals), 0)::int from crm_backfill(true)), (select total + 1 from crm_t),
          'dry run counts a sent lead, not a queued one');
select is((select count(*)::int from crm_deals), (select deals_before from crm_t), 'dry run writes nothing');
select crm_backfill(false);
select is((select stage from crm_deals where campaign_id = 'crm-test-c' and email = 'bounced@example.com'), 'Bounced',
          'real run creates the deal at Bounced');

select * from finish();
rollback;
