-- supabase/tests/lume_cron_test.sql
-- The cron side of Lume: the three pg_cron jobs and lume_rotation_tick(). The
-- behavioural half creates lume_url / lume_hook_secret for the length of the
-- transaction, but ONLY when the live vault has neither: a deployed Lume has
-- both, the tick would then queue a request to the live URL, and those
-- assertions are skipped rather than failed (the plan count never changes).
-- Everything rolls back, including the secrets, the rotation rule and the
-- pg_net queue rows (the pg_net worker only sends committed rows).
begin;
select plan(28);

-- the vault state has to be snapshotted before this file adds its own secrets
create temp table lume_cron_t as
  select exists (select 1 from vault.secrets where name in ('lume_url', 'lume_hook_secret')) as live_secrets;

-- function -------------------------------------------------------------------
select has_function('public', 'lume_rotation_tick', 'lume_rotation_tick() exists');
select ok((select prosecdef from pg_proc where proname = 'lume_rotation_tick' and pronamespace = 'public'::regnamespace),
          'lume_rotation_tick() is security definer');
select ok((select proconfig @> array['search_path=pg_catalog, public'] from pg_proc where proname = 'lume_rotation_tick' and pronamespace = 'public'::regnamespace),
          'lume_rotation_tick() pins search_path, catalog first');
select ok((select proconfig @> array['lock_timeout=1s'] from pg_proc where proname = 'lume_rotation_tick' and pronamespace = 'public'::regnamespace),
          'lume_rotation_tick() gives up on a blocked call after 1s');
select ok(not has_function_privilege('anon', 'lume_rotation_tick()', 'execute'), 'anon cannot execute lume_rotation_tick()');
select ok(not has_function_privilege('authenticated', 'lume_rotation_tick()', 'execute'), 'authenticated cannot execute lume_rotation_tick()');

-- cron jobs ------------------------------------------------------------------
select is((select count(*)::int from cron.job where jobname in ('lume-rotation-tick', 'lume-events-purge', 'cron-history-prune')),
          3, 'the three lume cron jobs are scheduled');
select is((select count(*)::int from cron.job where jobname in ('lume-rotation-tick', 'lume-events-purge', 'cron-history-prune') and active),
          3, 'all three are active');
select is((select schedule from cron.job where jobname = 'lume-rotation-tick'), '*/15 * * * *', 'lume-rotation-tick runs every 15 minutes');
select is((select command from cron.job where jobname = 'lume-rotation-tick'), 'select public.lume_rotation_tick()', 'lume-rotation-tick only calls the tick');
select is((select schedule from cron.job where jobname = 'lume-events-purge'), '30 4 * * *', 'lume-events-purge runs daily at 04:30 UTC');
select is((select command from cron.job where jobname = 'lume-events-purge'),
          $$delete from public.events where created_at < now() - interval '90 days'$$, 'lume-events-purge keeps 90 days of events');
select is((select schedule from cron.job where jobname = 'cron-history-prune'), '0 3 * * *', 'cron-history-prune runs daily at 03:00 UTC');
select is((select command from cron.job where jobname = 'cron-history-prune'),
          $$delete from cron.job_run_details where end_time < now() - interval '30 days'$$, 'cron-history-prune keeps 30 days of run history');

-- no secrets, a due rule: the tick returns silently --------------------------
insert into rotation_rules (id, name, campaign_id, cron, active, next_run_at)
  values ('00000000-0000-0000-0000-000000000401', 'cron test', 'lume-cron-test', '*/15 * * * *', true, now() - interval '1 minute');
select lives_ok($$select lume_rotation_tick()$$, 'lume_rotation_tick() runs without secrets');
select case when (select live_secrets from lume_cron_t)
  then skip('live vault already has lume secrets')
  else is((select count(*)::int from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          0, 'without lume secrets in the vault a due rule queues no request') end;

-- secrets for the rest of the transaction (only when the live vault has neither)
select vault.create_secret('https://lume.test', 'lume_url') where not (select live_secrets from lume_cron_t);
select vault.create_secret('s3cret', 'lume_hook_secret') where not (select live_secrets from lume_cron_t);

-- a due active rule: exactly one notify-only POST ----------------------------
select lives_ok($$select lume_rotation_tick()$$, 'lume_rotation_tick() runs with secrets and a due rule');
select case when (select live_secrets from lume_cron_t) then skip('live vault already has lume secrets')
  else is((select count(*)::int from net.http_request_queue where url = 'https://lume.test/api/cron/rotation-tick'),
          1, 'a due active rule queues exactly one request to lume_url/api/cron/rotation-tick') end;
select case when (select live_secrets from lume_cron_t) then skip('live vault already has lume secrets')
  else is((select method from net.http_request_queue where url = 'https://lume.test/api/cron/rotation-tick'),
          'POST', 'the tick POSTs') end;
select case when (select live_secrets from lume_cron_t) then skip('live vault already has lume secrets')
  else is((select headers->>'X-Lume-Hook-Secret' from net.http_request_queue where url = 'https://lume.test/api/cron/rotation-tick'),
          's3cret', 'the tick carries lume_hook_secret') end;
select case when (select live_secrets from lume_cron_t) then skip('live vault already has lume secrets')
  else is((select headers->>'Content-Type' from net.http_request_queue where url = 'https://lume.test/api/cron/rotation-tick'),
          'application/json', 'the tick sends JSON') end;
select case when (select live_secrets from lume_cron_t) then skip('live vault already has lume secrets')
  else is((select convert_from(body, 'utf8') from net.http_request_queue where url = 'https://lume.test/api/cron/rotation-tick'),
          '{}', 'the body is empty: Lume decides, the tick carries nothing') end;

-- an inactive rule: nothing new ----------------------------------------------
update rotation_rules set active = false where id = '00000000-0000-0000-0000-000000000401';
select lives_ok($$select lume_rotation_tick()$$, 'lume_rotation_tick() runs with no active rule');
select case when (select live_secrets from lume_cron_t) then skip('live vault already has lume secrets')
  else is((select count(*)::int from net.http_request_queue where url = 'https://lume.test/api/cron/rotation-tick'),
          1, 'an inactive rule queues nothing new') end;

-- active but not yet due: nothing new ----------------------------------------
update rotation_rules set active = true, next_run_at = now() + interval '1 hour' where id = '00000000-0000-0000-0000-000000000401';
select lives_ok($$select lume_rotation_tick()$$, 'lume_rotation_tick() runs with a rule that is not yet due');
select case when (select live_secrets from lume_cron_t) then skip('live vault already has lume secrets')
  else is((select count(*)::int from net.http_request_queue where url = 'https://lume.test/api/cron/rotation-tick'),
          1, 'an active rule that is not yet due queues nothing new') end;

-- active and never run (next_run_at null) counts as due ----------------------
update rotation_rules set next_run_at = null where id = '00000000-0000-0000-0000-000000000401';
select lives_ok($$select lume_rotation_tick()$$, 'lume_rotation_tick() runs with a never-run rule');
select case when (select live_secrets from lume_cron_t) then skip('live vault already has lume secrets')
  else is((select count(*)::int from net.http_request_queue where url = 'https://lume.test/api/cron/rotation-tick'),
          2, 'an active rule with no next_run_at yet counts as due') end;

select * from finish();
rollback;
