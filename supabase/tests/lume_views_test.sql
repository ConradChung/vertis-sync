-- supabase/tests/lume_views_test.sql
-- Runs against a database that already holds pipeline rows, so every count is
-- scoped to the seeded ids. Everything rolls back.
begin;
select plan(22);

-- one row per gate kind ------------------------------------------------------
insert into telegram_ingests (id, telegram_chat_id, sender_chat_id, filename, storage_path, row_count, status)
  values ('00000000-0000-0000-0000-000000000001','1','1','a.csv','telegram/a.csv',10,'awaiting_approval');
insert into validation_jobs (id, filename, total_rows, status, finder_status)
  values ('00000000-0000-0000-0000-000000000002','b.csv',5,'pending','awaiting_decision');
insert into validation_jobs (id, filename, total_rows, status, instantly_status)
  values ('00000000-0000-0000-0000-000000000003','c.csv',5,'completed','awaiting_campaign');
insert into validation_jobs (id, filename, total_rows, status, watchdog_status)
  values ('00000000-0000-0000-0000-000000000004','d.csv',5,'processing','awaiting');
insert into job_batches (id, batch_date, status) values ('00000000-0000-0000-0000-000000000005','2099-01-01','awaiting_review');
insert into job_batches (id, batch_date, status, write_status) values ('00000000-0000-0000-0000-000000000006','2099-01-02','ranked','awaiting');
insert into apollo_orders (id, apollo_url) values ('00000000-0000-0000-0000-000000000007','https://app.apollo.io/#/people?x=1');
insert into pending_actions (id, kind) values ('00000000-0000-0000-0000-000000000008','assign_leads');

select is((select count(*)::int from lume_gates where target_id in (
  '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',
  '00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000006',
  '00000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000008')), 8, 'one gate per seeded row');
select is((select kind from lume_gates where target_id='00000000-0000-0000-0000-000000000001'), 'ingest_approval', 'ingest gate');
select is((select kind from lume_gates where target_id='00000000-0000-0000-0000-000000000002'), 'finder_decision', 'finder gate');
select is((select kind from lume_gates where target_id='00000000-0000-0000-0000-000000000003'), 'campaign_choice', 'campaign gate');
select is((select kind from lume_gates where target_id='00000000-0000-0000-0000-000000000004'), 'stall', 'stall gate');
select is((select kind from lume_gates where target_id='00000000-0000-0000-0000-000000000005'), 'jobs_review', 'gate 1');
select is((select kind from lume_gates where target_id='00000000-0000-0000-0000-000000000006'), 'jobs_write', 'gate 2');
select is((select actions[1] from lume_gates where target_id='00000000-0000-0000-0000-000000000007'), 'lfo_count', 'lfo actions');
select is((select kind from lume_gates where target_id='00000000-0000-0000-0000-000000000008'), 'lume_action', 'pending action gate');

-- orders: 1 ingest + 1 apollo order + 2 batches + 3 jobs (source defaults to csv -> dashboard_job)
select is((select count(*)::int from lume_orders where id in (
  '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',
  '00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000006',
  '00000000-0000-0000-0000-000000000007')), 7, 'orders: ingest + apollo order + batches + dashboard jobs count as pulls');

-- lead bank: a valid, un-pushed row whose email is already banked shows once, from lead_bank
insert into lead_bank (campaign_id, email, first_name, state)
  values ('lume-views-test', 'Lume.Dup@example.com', 'Dup', 'queued');
insert into validation_rows (id, job_id, email, row_index, status, instantly_status, processed_at, row_data) values
  ('00000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000003', 'lume.dup@example.com', 1, 'valid', 'skipped', now(),
   '{"First Name":"Dup","Company Name":"Acme"}'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000003', 'lume.new@example.com', 2, 'valid', 'skipped', now(),
   '{"first_name":"New","company_name":"Beta"}');
select is((select count(*)::int from lume_lead_bank where lower(email) = 'lume.dup@example.com'), 1, 'banked email appears once');
select is((select origin from lume_lead_bank where lower(email) = 'lume.dup@example.com'), 'lead_bank', 'and it comes from lead_bank');
select is((select origin || ':' || first_name || ':' || company_name from lume_lead_bank where email = 'lume.new@example.com'),
          'validation_rows:New:Beta', 'un-banked valid row appears from validation_rows with snake_case keys read');

-- scheduled jobs reach cron.job through the definer function
select ok(exists (select 1 from json_array_elements(lume_scheduled_jobs()) e where e->>'name' = 'pipeline-watchdog'),
          'lume_scheduled_jobs() lists the pipeline-watchdog cron job');

-- grants: views and functions are for the service role only
select ok(not has_table_privilege('anon', 'lume_gates', 'select'), 'anon cannot read lume_gates');
select ok(not has_table_privilege('authenticated', 'lume_gates', 'select'), 'authenticated cannot read lume_gates');
select ok(not has_table_privilege('anon', 'lume_orders', 'select'), 'anon cannot read lume_orders');
select ok(not has_table_privilege('anon', 'lume_lead_bank', 'select'), 'anon cannot read lume_lead_bank');
select ok(not has_function_privilege('anon', 'lume_overview()', 'execute'), 'anon cannot call lume_overview()');
select ok(not has_function_privilege('authenticated', 'lume_scheduled_jobs()', 'execute'), 'authenticated cannot call lume_scheduled_jobs()');
select ok(has_table_privilege('service_role', 'lume_gates', 'select'), 'service_role can read lume_gates');

-- RLS (Task 1 gap): a non-owner authenticated JWT sees no events, even ones inserted by the owner
insert into events (type, title) values ('reply', 'lume_views_test rls probe');
set local role authenticated;
select set_config('request.jwt.claims', '{"email":"nobody@example.com"}', true);
select set_config('lume_test.events_seen', (select count(*) from events)::text, true);
reset role;
select is(current_setting('lume_test.events_seen', true)::int, 0, 'non-owner authenticated sees no events rows');

select * from finish();
rollback;
