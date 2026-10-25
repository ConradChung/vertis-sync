-- supabase/tests/lume_triggers_test.sql
-- Runs against a database that already holds pipeline rows, so every count is
-- scoped to the seeded ids (source_id / body->>'target_id') or a throwaway
-- campaign id. job_batches dates are in 2099 because batch_date is unique and
-- live scrapes land every other day. Everything rolls back, including the two
-- vault secrets created below and the pg_net queue rows they cause (the pg_net
-- worker only sends committed rows).
--
-- The gate-hook assertions create whichever of lume_url / lume_hook_secret
-- the live vault lacks, for the length of the transaction. Presence is
-- tracked per secret: once the live vault holds its own lume_url the url
-- assertion is skipped, its own lume_hook_secret the header assertion, and
-- both the negative "no secrets" case (the ingest then does queue a request,
-- to the live URL). A half-configured vault therefore skips rather than
-- fails; the plan count never changes.
--
-- The final "writer survives" proof takes ACCESS EXCLUSIVE on events until
-- rollback. It is skipped unless lume.allow_destructive_tests = on, which
-- pg_prove cannot inject as `set local`; pass it through libpq instead:
--   PGOPTIONS="-c lume.allow_destructive_tests=on" supabase test db
-- Never enable it against prod while a validation is in flight.
begin;
select plan(63);

-- the vault state has to be snapshotted before this file adds its own secrets
create temp table lume_trig_t as
  select exists (select 1 from vault.secrets where name = 'lume_url') as has_url,
         exists (select 1 from vault.secrets where name = 'lume_hook_secret') as has_secret;

-- structure ------------------------------------------------------------------
select has_function('public', 'lume_event_on_change', 'lume_event_on_change() exists');
select has_function('public', 'lume_gate_opened', 'lume_gate_opened() exists');
select has_function('public', 'lume_gate_kind', 'lume_gate_kind() exists');
select ok((select proconfig @> array['search_path=pg_catalog, public'] from pg_proc where proname = 'lume_event_on_change'),
          'lume_event_on_change() pins search_path, catalog first');
select ok((select proconfig @> array['search_path=pg_catalog, public'] from pg_proc where proname = 'lume_gate_opened'),
          'lume_gate_opened() pins search_path, catalog first');
select ok((select proconfig @> array['search_path=pg_catalog, public'] from pg_proc where proname = 'lume_gate_kind'),
          'lume_gate_kind() pins search_path, catalog first');
select ok((select proconfig @> array['lock_timeout=1s'] from pg_proc where proname = 'lume_event_on_change'),
          'lume_event_on_change() gives up on a blocked insert after 1s');
select ok((select proconfig @> array['lock_timeout=1s'] from pg_proc where proname = 'lume_gate_opened'),
          'lume_gate_opened() gives up on a blocked call after 1s');
select ok(not has_function_privilege('anon', 'lume_event_on_change()', 'execute'), 'anon cannot execute lume_event_on_change()');
select ok(not has_function_privilege('authenticated', 'lume_gate_opened()', 'execute'), 'authenticated cannot execute lume_gate_opened()');
select has_trigger('public', 'validation_jobs', 'lume_events_validation_jobs', 'validation_jobs has the events trigger');
select has_trigger('public', 'validation_jobs', 'lume_gate_validation_jobs', 'validation_jobs has the gate trigger');
select has_trigger('public', 'lead_bank', 'lume_events_lead_bank', 'lead_bank has the events trigger');
select has_trigger('public', 'rotation_runs', 'lume_events_rotation_runs', 'rotation_runs has the events trigger');

-- gate hook without secrets: a gate opens, nothing is queued -----------------
-- (skipped once the live vault has both lume secrets: the ingest then does
-- queue a request, to the live URL, which rolls back with everything else)
insert into telegram_ingests (id, telegram_chat_id, sender_chat_id, filename, storage_path, row_count, status)
  values ('00000000-0000-0000-0000-000000000303', '1', '1', 'trig.csv', 'telegram/trig.csv', 10, 'awaiting_approval');
select case when (select has_url and has_secret from lume_trig_t)
  then skip('live vault already has both lume secrets')
  else is((select count(*)::int from net.http_request_queue
           where convert_from(body, 'utf8')::jsonb->>'target_id' = '00000000-0000-0000-0000-000000000303'),
          0, 'without both lume secrets in the vault an opened gate queues no hook request') end;

-- secrets for the rest of the transaction (rolled back with everything else);
-- each is created only when the live vault lacks it, so the file never collides
select vault.create_secret('https://lume.test', 'lume_url') where not (select has_url from lume_trig_t);
select vault.create_secret('s3cret', 'lume_hook_secret') where not (select has_secret from lume_trig_t);

-- validation_jobs ------------------------------------------------------------
insert into validation_jobs (id, filename, total_rows, status)
  values ('00000000-0000-0000-0000-000000000301', 'trig-a.csv', 5, 'pending');
select is((select string_agg(type, ',' order by id) from events where source = 'validation_jobs' and source_id = '00000000-0000-0000-0000-000000000301'),
          'validation_jobs.inserted', 'inserting a job writes one inserted event');

-- the validator's heartbeat: changes no watched column, must write nothing
update validation_jobs set processed_rows = 1, valid_count = 1, invalid_count = 0
  where id = '00000000-0000-0000-0000-000000000301';
select is((select count(*)::int from events where source = 'validation_jobs' and source_id = '00000000-0000-0000-0000-000000000301'),
          1, 'a heartbeat PATCH that changes no watched column inserts no events row');
-- a SET that names a watched column but leaves its value alone: still nothing
update validation_jobs set status = status where id = '00000000-0000-0000-0000-000000000301';
select is((select count(*)::int from events where source = 'validation_jobs' and source_id = '00000000-0000-0000-0000-000000000301'),
          1, 'setting a watched column to its own value inserts no events row');

update validation_jobs set status = 'processing' where id = '00000000-0000-0000-0000-000000000301';
select is((select count(*)::int from events where type = 'validation_jobs.status' and source_id = '00000000-0000-0000-0000-000000000301'),
          1, 'status change writes one validation_jobs.status event');
select is((select (payload->>'from') || '>' || (payload->>'to') from events where type = 'validation_jobs.status' and source_id = '00000000-0000-0000-0000-000000000301'),
          'pending>processing', 'payload carries from and to');
select is((select title from events where type = 'validation_jobs.status' and source_id = '00000000-0000-0000-0000-000000000301'),
          'validation_jobs status: pending → processing', 'title reads table column: from → to');

-- the finder gate opens: one event and one real pg_net request
update validation_jobs set finder_status = 'awaiting_decision' where id = '00000000-0000-0000-0000-000000000301';
select is((select count(*)::int from events where type = 'validation_jobs.finder_status' and source_id = '00000000-0000-0000-0000-000000000301'),
          1, 'finder_status change writes a second event');
select is((select count(*)::int from events where source = 'validation_jobs' and source_id = '00000000-0000-0000-0000-000000000301'),
          3, 'three events so far: inserted, status, finder_status');
select is((select count(*)::int from net.http_request_queue
           where convert_from(body, 'utf8')::jsonb->>'target_id' = '00000000-0000-0000-0000-000000000301'),
          1, 'the finder gate queues exactly one hook request');
select case when (select has_url from lume_trig_t) then skip('live vault has its own lume_url')
  else is((select url from net.http_request_queue
           where convert_from(body, 'utf8')::jsonb->>'target_id' = '00000000-0000-0000-0000-000000000301'),
          'https://lume.test/api/hooks/gate-opened', 'the hook posts to lume_url/api/hooks/gate-opened') end;
select case when (select has_secret from lume_trig_t) then skip('live vault has its own lume_hook_secret')
  else is((select headers->>'X-Lume-Hook-Secret' from net.http_request_queue
           where convert_from(body, 'utf8')::jsonb->>'target_id' = '00000000-0000-0000-0000-000000000301'),
          's3cret', 'the hook carries lume_hook_secret') end;
select is((select convert_from(body, 'utf8')::jsonb->>'kind' from net.http_request_queue
           where convert_from(body, 'utf8')::jsonb->>'target_id' = '00000000-0000-0000-0000-000000000301'),
          'finder_decision', 'the hook body names the gate kind');
select is((select convert_from(body, 'utf8')::jsonb->>'target_table' from net.http_request_queue
           where convert_from(body, 'utf8')::jsonb->>'target_id' = '00000000-0000-0000-0000-000000000301'),
          'validation_jobs', 'the hook body names the target table');

-- the writers are the service role; firing must survive the API-role revoke
set local role service_role;
update validation_jobs set enrich_started = true where id = '00000000-0000-0000-0000-000000000301';
reset role;
select is((select count(*)::int from events where type = 'validation_jobs.enrich_started' and source_id = '00000000-0000-0000-0000-000000000301'),
          1, 'a service_role write still fires the trigger after the API-role revoke');

-- one PATCH touching two watched columns: one event per changed column, but
-- one hook (campaign_choice outranks stall)
update validation_jobs set instantly_status = 'awaiting_campaign', watchdog_status = 'awaiting'
  where id = '00000000-0000-0000-0000-000000000301';
select is((select string_agg(type, ',' order by id) from events where source = 'validation_jobs' and source_id = '00000000-0000-0000-0000-000000000301'),
          'validation_jobs.inserted,validation_jobs.status,validation_jobs.finder_status,validation_jobs.enrich_started,validation_jobs.instantly_status,validation_jobs.watchdog_status',
          'one event per changed watched column, in column order');
select is((select string_agg(convert_from(body, 'utf8')::jsonb->>'kind', ',' order by id) from net.http_request_queue
           where convert_from(body, 'utf8')::jsonb->>'target_id' = '00000000-0000-0000-0000-000000000301'),
          'finder_decision,campaign_choice', 'a change opening two gates at once queues one hook, highest precedence first');
select is((select payload->'row'->>'filename' from events where type = 'validation_jobs.status' and source_id = '00000000-0000-0000-0000-000000000301'),
          'trig-a.csv', 'update events carry the full row under payload.row');

-- telegram_ingests (row seeded above) ----------------------------------------
select is((select title from events where type = 'telegram_ingests.inserted' and source_id = '00000000-0000-0000-0000-000000000303'),
          'trig.csv', 'inserting an ingest writes telegram_ingests.inserted titled by filename');
select lives_ok($$insert into telegram_ingests (id, telegram_chat_id, sender_chat_id, filename, storage_path, row_count, sender_platform)
  values ('00000000-0000-0000-0000-000000000308', '1', '1', 'lume.csv', 'lume/lume.csv', 3, 'lume')$$,
  'sender_platform = lume is accepted');
select throws_ok($$insert into telegram_ingests (id, telegram_chat_id, sender_chat_id, filename, storage_path, row_count, sender_platform)
  values ('00000000-0000-0000-0000-000000000309', '1', '1', 'x.csv', 'x/x.csv', 3, 'carrier_pigeon')$$,
  '23514', null, 'sender_platform still rejects unknown platforms');
update telegram_ingests set status = 'approved' where id = '00000000-0000-0000-0000-000000000303';
select is((select count(*)::int from events where type = 'telegram_ingests.status' and source_id = '00000000-0000-0000-0000-000000000303'),
          1, 'ingest status change writes telegram_ingests.status');

-- job_batches ----------------------------------------------------------------
insert into job_batches (id, batch_date, status) values ('00000000-0000-0000-0000-000000000304', '2099-03-01', 'awaiting_review');
select is((select title from events where type = 'job_batches.inserted' and source_id = '00000000-0000-0000-0000-000000000304'),
          '2099-03-01', 'inserting a batch writes job_batches.inserted titled by batch_date');
update job_batches set status = 'approved', review_status = 'claimed', write_status = 'awaiting'
  where id = '00000000-0000-0000-0000-000000000304';
select is((select string_agg(type, ',' order by id) from events where source = 'job_batches' and source_id = '00000000-0000-0000-0000-000000000304' and type <> 'job_batches.inserted'),
          'job_batches.status,job_batches.write_status', 'status and write_status changes each write an event; review_status is not watched');

-- apollo_orders --------------------------------------------------------------
insert into apollo_orders (id, apollo_url) values ('00000000-0000-0000-0000-000000000306', 'https://app.apollo.io/#/people?trig=1');
update apollo_orders set status = 'ordering', count_status = 'claimed', contact_count = 500
  where id = '00000000-0000-0000-0000-000000000306';
select is((select string_agg(type, ',' order by id) from events where source = 'apollo_orders' and source_id = '00000000-0000-0000-0000-000000000306'),
          'apollo_orders.inserted,apollo_orders.status', 'apollo order insert and status change each write an event');

-- pending_actions ------------------------------------------------------------
insert into pending_actions (id, kind) values ('00000000-0000-0000-0000-000000000307', 'assign_leads');
select is((select title from events where type = 'pending_actions.inserted' and source_id = '00000000-0000-0000-0000-000000000307'),
          'assign_leads', 'inserting a pending action writes pending_actions.inserted titled by kind');
update pending_actions set status = 'approved', claim_status = 'claimed' where id = '00000000-0000-0000-0000-000000000307';
select is((select count(*)::int from events where type = 'pending_actions.status' and source_id = '00000000-0000-0000-0000-000000000307'),
          1, 'pending action status change writes pending_actions.status; claim_status is not watched');

-- agent_runs -----------------------------------------------------------------
insert into agent_runs (id, prompt) values ('00000000-0000-0000-0000-00000000030a', 'trigger test');
update agent_runs set status = 'done', finished_at = now() where id = '00000000-0000-0000-0000-00000000030a';
select is((select string_agg(type, ',' order by id) from events where source = 'agent_runs' and source_id = '00000000-0000-0000-0000-00000000030a'),
          'agent_runs.inserted,agent_runs.status', 'agent run insert and status change each write an event');

-- rotation_runs (insert only) ------------------------------------------------
insert into rotation_runs (campaign_id, pushed, note) values ('lume-triggers-test', 0, 'trigger test');
select is((select count(*)::int from events where type = 'rotation_runs.inserted' and campaign_id = 'lume-triggers-test'),
          1, 'inserting a rotation run writes rotation_runs.inserted with its campaign_id');

-- lead_bank (update only) ----------------------------------------------------
insert into lead_bank (campaign_id, email, first_name, state) values ('lume-triggers-test', 'trig@example.com', 'Trig', 'queued');
select is((select count(*)::int from events where source = 'lead_bank' and campaign_id = 'lume-triggers-test'),
          0, 'inserting a lead_bank row writes nothing');
update lead_bank set state = 'active', pushed_at = now() where campaign_id = 'lume-triggers-test' and email = 'trig@example.com';
select is((select lead_email from events where type = 'lead_bank.state' and campaign_id = 'lume-triggers-test'),
          'trig@example.com', 'lead_bank state change writes lead_bank.state with the lead email');
update lead_bank set first_name = 'Trigger' where campaign_id = 'lume-triggers-test' and email = 'trig@example.com';
select is((select count(*)::int from events where source = 'lead_bank' and campaign_id = 'lume-triggers-test'),
          1, 'a lead_bank update that leaves state alone writes nothing');

-- gate kinds: the pure function behind lume_gate_opened() ---------------------
select is(lume_gate_kind('telegram_ingests', 'INSERT', '{"status":"awaiting_approval"}', '{}'), 'ingest_approval', 'new ingest → ingest_approval');
select is(lume_gate_kind('telegram_ingests', 'UPDATE', '{"status":"approved"}', '{"status":"awaiting_approval"}'), null::text, 'approving an ingest opens no gate');
select is(lume_gate_kind('validation_jobs', 'UPDATE', '{"finder_status":"awaiting_decision","instantly_status":"idle","watchdog_status":"idle"}',
                                                     '{"finder_status":"idle","instantly_status":"idle","watchdog_status":"idle"}'), 'finder_decision', 'finder prompt → finder_decision');
select is(lume_gate_kind('validation_jobs', 'UPDATE', '{"finder_status":"decided","instantly_status":"awaiting_campaign","watchdog_status":"idle"}',
                                                     '{"finder_status":"decided","instantly_status":"idle","watchdog_status":"idle"}'), 'campaign_choice', 'campaign prompt → campaign_choice');
select is(lume_gate_kind('validation_jobs', 'UPDATE', '{"finder_status":"idle","instantly_status":"idle","watchdog_status":"awaiting"}',
                                                     '{"finder_status":"idle","instantly_status":"idle","watchdog_status":"idle"}'), 'stall', 'watchdog claim → stall');
select is(lume_gate_kind('validation_jobs', 'UPDATE', '{"finder_status":"awaiting_decision","instantly_status":"idle","watchdog_status":"awaiting"}',
                                                     '{"finder_status":"awaiting_decision","instantly_status":"idle","watchdog_status":"idle"}'), 'stall', 'an unchanged open finder gate does not mask a new stall');
select is(lume_gate_kind('job_batches', 'INSERT', '{"status":"awaiting_review","write_status":"idle","watchdog_status":"idle"}', '{}'), 'jobs_review', 'new batch → jobs_review');
select is(lume_gate_kind('job_batches', 'UPDATE', '{"status":"waiting_fill","write_status":"idle","watchdog_status":"idle"}',
                                                 '{"status":"resolving","write_status":"idle","watchdog_status":"idle"}'), 'jobs_fill', 'waiting_fill → jobs_fill');
select is(lume_gate_kind('job_batches', 'UPDATE', '{"status":"ranked","write_status":"awaiting","watchdog_status":"idle"}',
                                                 '{"status":"delivered","write_status":"idle","watchdog_status":"idle"}'), 'jobs_write', 'write_status awaiting → jobs_write');
select is(lume_gate_kind('job_batches', 'UPDATE', '{"status":"resolving","write_status":"idle","watchdog_status":"awaiting"}',
                                                 '{"status":"resolving","write_status":"idle","watchdog_status":"idle"}'), 'jobs_stall', 'batch watchdog claim → jobs_stall');
select is(lume_gate_kind('job_batches', 'UPDATE', '{"status":"ranked","write_status":"idle","watchdog_status":"idle"}',
                                                 '{"status":"delivered","write_status":"idle","watchdog_status":"idle"}'), null::text, 'status=ranked alone is not a gate (Gate 2 is write_status)');
select is(lume_gate_kind('apollo_orders', 'INSERT', '{"status":"awaiting_count"}', '{}'), 'lfo_count', 'new apollo order → lfo_count');
select is(lume_gate_kind('pending_actions', 'INSERT', '{"status":"awaiting"}', '{}'), 'lume_action', 'new pending action → lume_action');
select is(lume_gate_kind('pending_actions', 'UPDATE', '{"status":"approved"}', '{"status":"awaiting"}'), null::text, 'deciding a pending action opens no gate');

-- safety: a failing events insert must never abort the writer ----------------
-- Destructive: the ALTER holds ACCESS EXCLUSIVE on events until rollback, so
-- any validation in flight would stall on its events inserts for the rest of
-- this transaction. Skipped unless lume.allow_destructive_tests = on.
do $$ begin
  if current_setting('lume.allow_destructive_tests', true) = 'on' then
    alter table events add constraint lume_test_boom check (type <> 'validation_jobs.status') not valid;
  end if;
end $$;
select case when current_setting('lume.allow_destructive_tests', true) is distinct from 'on'
  then skip('destructive proof only runs off-prod (PGOPTIONS="-c lume.allow_destructive_tests=on")')
  else lives_ok($$update validation_jobs set status = 'completed' where id = '00000000-0000-0000-0000-000000000301'$$,
                'the status update succeeds although the events insert fails') end;
select case when current_setting('lume.allow_destructive_tests', true) is distinct from 'on'
  then skip('destructive proof only runs off-prod')
  else is((select status from validation_jobs where id = '00000000-0000-0000-0000-000000000301'), 'completed', 'and the new status landed') end;
select case when current_setting('lume.allow_destructive_tests', true) is distinct from 'on'
  then skip('destructive proof only runs off-prod')
  else is((select count(*)::int from events where type = 'validation_jobs.status' and source_id = '00000000-0000-0000-0000-000000000301'),
          1, 'the failed event row is simply absent') end;
do $$ begin
  if current_setting('lume.allow_destructive_tests', true) = 'on' then
    alter table events drop constraint lume_test_boom;
  end if;
end $$;

select * from finish();
rollback;
