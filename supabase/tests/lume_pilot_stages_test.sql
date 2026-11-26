-- supabase/tests/lume_pilot_stages_test.sql
-- 90-day plan, phase 2: pilot stages, pilot columns on crm_deals, lume_week_notes.
-- Everything rolls back.
begin;
select plan(14);

select is((select string_agg(name, ',' order by position) from crm_stages where campaign_id = '_default' and position >= 8),
          'Conversation,Demo,Pilot,Paid', 'the four pilot stages follow the original eight');
select is((select string_agg(name, ',' order by position) from crm_stages where campaign_id = '_default' and position < 8),
          'Contacted,Replied,Interested,Meeting booked,Won,Lost,Bounced,Not now', 'the original stages keep their order');
select is((select is_terminal from crm_stages where campaign_id = '_default' and name = 'Paid'), true, 'Paid is terminal');
select is((select count(*)::int from crm_stages where campaign_id = '_default' and name in ('Conversation','Demo','Pilot') and is_terminal), 0,
          'Conversation, Demo and Pilot are open stages');

select has_column('public', 'crm_deals', 'pilot_start_date', 'crm_deals.pilot_start_date exists');
select col_type_is('public', 'crm_deals', 'pilot_start_date', 'date', 'pilot_start_date is a date');
select has_column('public', 'crm_deals', 'pilot_checkin_10_done_at', 'day-10 check-in column exists');
select has_column('public', 'crm_deals', 'pilot_checkin_25_done_at', 'day-25 check-in column exists');
select has_column('public', 'crm_deals', 'referral_asked_at', 'referral flag column exists');

-- A deal can be moved onto and along the pilot line through crm_set_stage().
insert into crm_deals (id, campaign_id, email, name) values ('00000000-0000-0000-0000-0000000090d1', 'camp-90d', 'pilot@example.com', 'Pilot Lead');
select is(crm_set_stage('00000000-0000-0000-0000-0000000090d1', 'Conversation', 'user'), 'Contacted', 'Contacted -> Conversation returns the old stage');
select is(crm_set_stage('00000000-0000-0000-0000-0000000090d1', 'Pilot', 'user'), 'Conversation', 'Conversation -> Pilot');
select is((select count(*)::int from crm_activities where deal_id = '00000000-0000-0000-0000-0000000090d1' and kind = 'stage_changed'
            and payload->>'to' in ('Conversation', 'Pilot')), 2, 'each move is logged with its target stage (what the scoreboard counts)');

select ok((select relrowsecurity from pg_class where oid = 'public.lume_week_notes'::regclass), 'lume_week_notes has RLS on');
select throws_ok($$insert into lume_week_notes (week_start, top_objection) values ('2026-11-24', 'x')$$, '23514', null,
                 'a week must start on a Monday');

select * from finish();
rollback;
