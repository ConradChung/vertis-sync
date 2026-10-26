-- supabase/tests/lume_cron_test.sql
-- The cron side of Lume: the three pg_cron jobs and lume_rotation_tick(). The
-- behavioural half creates whichever of lume_url / lume_hook_secret the live
-- vault lacks, for the length of the transaction. Presence is tracked per
-- secret: an assertion about the URL is skipped when the live vault has its
-- own lume_url, one about the header when it has its own lume_hook_secret,
-- and the "no secrets" case when it has both. Request counts match any URL
-- ending in /api/cron/rotation-tick, so they hold either way. A half-
-- configured vault therefore skips, never fails (the plan count never
-- changes). Everything rolls back, including the secrets, the rotation rule,
-- the pending actions and the pg_net queue rows (the pg_net worker only sends
-- committed rows).
begin;
select plan(45);

-- the vault state has to be snapshotted before this file adds its own secrets
create temp table lume_cron_t as
  select exists (select 1 from vault.secrets where name = 'lume_url') as has_url,
         exists (select 1 from vault.secrets where name = 'lume_hook_secret') as has_secret;

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
select ok((select prosrc !~* 'exception' from pg_proc where proname = 'lume_rotation_tick' and pronamespace = 'public'::regnamespace),
          'lume_rotation_tick() has no exception handler: a broken tick fails the cron run');
select has_index('public', 'pending_actions', 'pending_actions_one_awaiting_rule_idx', 'one awaiting action per (kind, rule) is enforced');

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
select case when (select has_url and has_secret from lume_cron_t)
  then skip('live vault already has both lume secrets')
  else is((select count(*)::int from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          0, 'without both lume secrets in the vault a due rule queues no request') end;

-- secrets for the rest of the transaction: create each one the live vault lacks
select vault.create_secret('https://lume.test', 'lume_url') where not (select has_url from lume_cron_t);
select vault.create_secret('s3cret', 'lume_hook_secret') where not (select has_secret from lume_cron_t);

-- a due active rule: exactly one notify-only POST ----------------------------
select lives_ok($$select lume_rotation_tick()$$, 'lume_rotation_tick() runs with secrets and a due rule');
select is((select count(*)::int from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          1, 'a due active rule queues exactly one request to /api/cron/rotation-tick');
select is((select method from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          'POST', 'the tick POSTs');
select case when (select has_url from lume_cron_t) then skip('live vault has its own lume_url')
  else is((select url from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          'https://lume.test/api/cron/rotation-tick', 'the tick posts to lume_url/api/cron/rotation-tick') end;
select case when (select has_secret from lume_cron_t) then skip('live vault has its own lume_hook_secret')
  else is((select headers->>'X-Lume-Hook-Secret' from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          's3cret', 'the tick carries lume_hook_secret') end;
select is((select headers->>'Content-Type' from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          'application/json', 'the tick sends JSON');
select is((select convert_from(body, 'utf8') from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          '{}', 'the body is empty: Lume decides, the tick carries nothing');

-- an inactive rule: nothing new ----------------------------------------------
update rotation_rules set active = false where id = '00000000-0000-0000-0000-000000000401';
select lives_ok($$select lume_rotation_tick()$$, 'lume_rotation_tick() runs with no active rule');
select is((select count(*)::int from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          1, 'an inactive rule queues nothing new');

-- active but not yet due: nothing new ----------------------------------------
update rotation_rules set active = true, next_run_at = now() + interval '1 hour' where id = '00000000-0000-0000-0000-000000000401';
select lives_ok($$select lume_rotation_tick()$$, 'lume_rotation_tick() runs with a rule that is not yet due');
select is((select count(*)::int from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          1, 'an active rule that is not yet due queues nothing new');

-- active and never run (next_run_at null) counts as due ----------------------
update rotation_rules set next_run_at = null where id = '00000000-0000-0000-0000-000000000401';
select lives_ok($$select lume_rotation_tick()$$, 'lume_rotation_tick() runs with a never-run rule');
select is((select count(*)::int from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          2, 'an active rule with no next_run_at yet counts as due');

-- no rule due, a fresh awaiting action: nothing new --------------------------
update rotation_rules set active = false where id = '00000000-0000-0000-0000-000000000401';
insert into pending_actions (id, kind, payload, requested_by, rule_id, created_at)
  values ('00000000-0000-0000-0000-000000000402', 'assign_leads', '{"summary":"cron test"}', 'rule',
          '00000000-0000-0000-0000-000000000401', now() - interval '1 hour');
select lives_ok($$select lume_rotation_tick()$$, 'lume_rotation_tick() runs with a fresh awaiting action');
select is((select count(*)::int from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          2, 'an awaiting action younger than 24 h queues nothing');

-- no rule due, an awaiting action older than 24 h: one POST so it expires ----
update pending_actions set created_at = now() - interval '25 hours' where id = '00000000-0000-0000-0000-000000000402';
select lives_ok($$select lume_rotation_tick()$$, 'lume_rotation_tick() runs with a stale awaiting action');
select is((select count(*)::int from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          3, 'an awaiting action older than 24 h queues a request even with no rule due');

-- no rule due, nothing stale awaiting, an approved action decided 1 min ago
-- and not executed: nothing new (the decide route is still running it) ------
update pending_actions set status = 'approved', decided_at = now() - interval '1 minute', executed_at = null
  where id = '00000000-0000-0000-0000-000000000402';
select lives_ok($$select lume_rotation_tick()$$, 'lume_rotation_tick() runs with a freshly approved action');
select is((select count(*)::int from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          3, 'an approved action decided under 2 minutes ago queues nothing');

-- approved more than 2 minutes ago and still not executed: one POST so the
-- sweeper re-dispatches it ----------------------------------------------------
update pending_actions set decided_at = now() - interval '3 minutes' where id = '00000000-0000-0000-0000-000000000402';
select lives_ok($$select lume_rotation_tick()$$, 'lume_rotation_tick() runs with a stuck approved action');
select is((select count(*)::int from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          4, 'an approved action not executed 2 minutes after its decision queues a request');

-- once executed it no longer counts ------------------------------------------
update pending_actions set executed_at = now() where id = '00000000-0000-0000-0000-000000000402';
select lives_ok($$select lume_rotation_tick()$$, 'lume_rotation_tick() runs with an executed approved action');
select is((select count(*)::int from net.http_request_queue where url like '%/api/cron/rotation-tick'),
          4, 'an executed approved action queues nothing');
update pending_actions set status = 'awaiting', decided_at = null, executed_at = null,
                           created_at = now() - interval '1 hour'
  where id = '00000000-0000-0000-0000-000000000402';

-- one awaiting action per (kind, rule) ---------------------------------------
select throws_ok(
  $$insert into pending_actions (kind, payload, requested_by, rule_id)
    values ('assign_leads', '{"summary":"dup"}', 'rule', '00000000-0000-0000-0000-000000000401')$$,
  '23505', null, 'a second awaiting assign_leads for the same rule is refused (23505)');
select lives_ok(
  $$insert into pending_actions (kind, payload, requested_by, rule_id)
    values ('activate_rule', '{"summary":"act"}', 'user', '00000000-0000-0000-0000-000000000401')$$,
  'a different kind for the same rule is allowed');
update pending_actions set status = 'expired' where id = '00000000-0000-0000-0000-000000000402';
select lives_ok(
  $$insert into pending_actions (kind, payload, requested_by, rule_id)
    values ('assign_leads', '{"summary":"again"}', 'rule', '00000000-0000-0000-0000-000000000401')$$,
  'once the first is no longer awaiting a new one is allowed');
select lives_ok(
  $$insert into pending_actions (kind, payload, requested_by)
    values ('assign_leads', '{"summary":"a"}', 'user'), ('assign_leads', '{"summary":"b"}', 'user')$$,
  'actions without a rule_id are not constrained');

select * from finish();
rollback;
