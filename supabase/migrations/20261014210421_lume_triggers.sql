-- supabase/migrations/20261014210421_lume_triggers.sql
-- Lume: the events feed and the gate-opened hook come from triggers, so none of
-- the 14 edge functions change and transitions made from Telegram, the
-- dashboard or the watchdog all land in `events`
-- (docs/lume/2026-10-14-lume-design.md, "Why triggers for the events feed").
--
-- These triggers sit on the tables the live validator and puller PATCH
-- constantly, so three rules hold throughout:
-- 1. Nothing here may abort the writer's statement. Both trigger bodies are
--    wrapped in an exception handler that logs a warning and returns. The
--    to_jsonb() calls run inside the body, not in DECLARE, because initialisers
--    run before the block's handler is in scope.
-- 2. Per-row cost stays minimal. Triggers fire `after insert or update of
--    <watched columns>`, so the validator's heartbeat PATCH (processed_rows,
--    valid_count, invalid_count) never runs them at all. When one does run it
--    compares only the watched columns and inserts only on a change.
-- 3. security definer with a pinned search_path, like lume_scheduled_jobs().
--
-- events retention is a purge cron in the next migration (lume_cron).

-- One events row per watched-column change. The watched columns arrive as
-- trigger arguments and must match the `update of` list on the trigger.
create or replace function lume_event_on_change() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  cols text[] := coalesce(tg_argv, '{}'::text[]);
  c text; oldv text; newv text; ttl text;
  n jsonb; o jsonb;
begin
  n := to_jsonb(new);
  if tg_op = 'INSERT' then
    insert into events (type, source, source_id, campaign_id, lead_email, title, payload)
    values (tg_table_name || '.inserted', tg_table_name, n->>'id',
            coalesce(n->>'instantly_campaign_id', n->>'campaign_id'), n->>'email',
            coalesce(n->>'filename', n->>'batch_date', n->>'apollo_url', n->>'kind', tg_table_name), n);
    return new;
  end if;
  o := to_jsonb(old);
  foreach c in array cols loop
    oldv := o->>c; newv := n->>c;
    if oldv is distinct from newv then
      ttl := format('%s %s: %s → %s', tg_table_name, c, coalesce(oldv, '∅'), coalesce(newv, '∅'));
      -- payload.row is the whole row (several KB for validation_jobs); the
      -- purge cron in lume_cron keeps the table bounded.
      insert into events (type, source, source_id, campaign_id, lead_email, title, payload)
      values (tg_table_name || '.' || c, tg_table_name, n->>'id',
              coalesce(n->>'instantly_campaign_id', n->>'campaign_id'), n->>'email',
              ttl, jsonb_build_object('column', c, 'from', oldv, 'to', newv, 'row', n));
    end if;
  end loop;
  return new;
exception when others then
  raise warning 'lume trigger %: %', tg_name, sqlerrm;
  return new;
end $$;

drop trigger if exists lume_events_validation_jobs on validation_jobs;
create trigger lume_events_validation_jobs
  after insert or update of status, finder_status, instantly_status, watchdog_status, enrich_started on validation_jobs
  for each row execute function lume_event_on_change('status', 'finder_status', 'instantly_status', 'watchdog_status', 'enrich_started');
drop trigger if exists lume_events_telegram_ingests on telegram_ingests;
create trigger lume_events_telegram_ingests
  after insert or update of status on telegram_ingests
  for each row execute function lume_event_on_change('status');
drop trigger if exists lume_events_job_batches on job_batches;
create trigger lume_events_job_batches
  after insert or update of status, write_status, watchdog_status on job_batches
  for each row execute function lume_event_on_change('status', 'write_status', 'watchdog_status');
drop trigger if exists lume_events_apollo_orders on apollo_orders;
create trigger lume_events_apollo_orders
  after insert or update of status on apollo_orders
  for each row execute function lume_event_on_change('status');
drop trigger if exists lume_events_lead_bank on lead_bank;
create trigger lume_events_lead_bank
  after update of state on lead_bank
  for each row execute function lume_event_on_change('state');
drop trigger if exists lume_events_rotation_runs on rotation_runs;
create trigger lume_events_rotation_runs
  after insert on rotation_runs
  for each row execute function lume_event_on_change();
drop trigger if exists lume_events_pending_actions on pending_actions;
create trigger lume_events_pending_actions
  after insert or update of status on pending_actions
  for each row execute function lume_event_on_change('status');
drop trigger if exists lume_events_agent_runs on agent_runs;
create trigger lume_events_agent_runs
  after insert or update of status on agent_runs
  for each row execute function lume_event_on_change('status');

-- Which manual gate, if any, a row change just opened. Pure, so the mapping is
-- testable without the vault or pg_net. One kind per change: the `when`
-- order is the precedence (e.g. finder_decision before stall).
create or replace function lume_gate_kind(tbl text, op text, n jsonb, o jsonb) returns text
language sql immutable set search_path = public, pg_catalog as $$
  select case tbl
    when 'telegram_ingests' then
      case when n->>'status' = 'awaiting_approval' and o->>'status' is distinct from 'awaiting_approval' then 'ingest_approval' end
    when 'validation_jobs' then
      case when n->>'finder_status' = 'awaiting_decision' and o->>'finder_status' is distinct from 'awaiting_decision' then 'finder_decision'
           when n->>'instantly_status' = 'awaiting_campaign' and o->>'instantly_status' is distinct from 'awaiting_campaign' then 'campaign_choice'
           when n->>'watchdog_status' = 'awaiting' and o->>'watchdog_status' is distinct from 'awaiting' then 'stall' end
    when 'job_batches' then
      case when n->>'status' = 'awaiting_review' and o->>'status' is distinct from 'awaiting_review' then 'jobs_review'
           when n->>'status' = 'waiting_fill' and o->>'status' is distinct from 'waiting_fill' then 'jobs_fill'
           when n->>'write_status' = 'awaiting' and o->>'write_status' is distinct from 'awaiting' then 'jobs_write'
           when n->>'watchdog_status' = 'awaiting' and o->>'watchdog_status' is distinct from 'awaiting' then 'jobs_stall' end
    when 'apollo_orders' then
      case when n->>'status' = 'awaiting_count' and o->>'status' is distinct from 'awaiting_count' then 'lfo_count' end
    when 'pending_actions' then
      case when op = 'INSERT' then 'lume_action' end
  end
$$;

-- A gate opened: tell Lume so it can ping Telegram with a deep link. pg_net is
-- fire-and-forget; the pipeline's own Telegram prompt was already sent, so a
-- failed hook costs only the link. Secrets from the vault, like
-- pipeline_watchdog(); until lume_url / lume_hook_secret exist this returns
-- without queueing anything.
create or replace function lume_gate_opened() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  url text; secret text; kind text; n jsonb; o jsonb;
begin
  n := to_jsonb(new);
  o := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  kind := lume_gate_kind(tg_table_name, tg_op, n, o);
  if kind is null then return new; end if;
  select decrypted_secret into url from vault.decrypted_secrets where name = 'lume_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'lume_hook_secret';
  if url is null or secret is null then return new; end if;
  perform net.http_post(
    url     := url || '/api/hooks/gate-opened',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Lume-Hook-Secret', secret),
    body    := jsonb_build_object('kind', kind, 'target_table', tg_table_name, 'target_id', n->>'id'));
  return new;
exception when others then
  raise warning 'lume trigger %: %', tg_name, sqlerrm;
  return new;
end $$;

-- Trigger functions cannot be called through PostgREST (they return trigger),
-- but they are SECURITY DEFINER, so say explicitly that no API role may
-- execute them. Firing is unaffected (see the service_role assertion in
-- supabase/tests/lume_triggers_test.sql).
revoke all on function lume_event_on_change() from public, anon, authenticated;
revoke all on function lume_gate_opened() from public, anon, authenticated;

drop trigger if exists lume_gate_telegram_ingests on telegram_ingests;
create trigger lume_gate_telegram_ingests
  after insert or update of status on telegram_ingests
  for each row execute function lume_gate_opened();
drop trigger if exists lume_gate_validation_jobs on validation_jobs;
create trigger lume_gate_validation_jobs
  after insert or update of finder_status, instantly_status, watchdog_status on validation_jobs
  for each row execute function lume_gate_opened();
drop trigger if exists lume_gate_job_batches on job_batches;
create trigger lume_gate_job_batches
  after insert or update of status, write_status, watchdog_status on job_batches
  for each row execute function lume_gate_opened();
drop trigger if exists lume_gate_apollo_orders on apollo_orders;
create trigger lume_gate_apollo_orders
  after insert or update of status on apollo_orders
  for each row execute function lume_gate_opened();
drop trigger if exists lume_gate_pending_actions on pending_actions;
create trigger lume_gate_pending_actions
  after insert on pending_actions
  for each row execute function lume_gate_opened();

-- Lume is a third intake surface for the CSV approval pipeline. The live
-- constraint is named telegram_ingests_sender_platform_check (checked in
-- pg_constraint before this migration was written).
alter table telegram_ingests drop constraint if exists telegram_ingests_sender_platform_check;
alter table telegram_ingests add constraint telegram_ingests_sender_platform_check
  check (sender_platform in ('telegram', 'slack', 'lume'));

-- Task 2 review follow-up: lume_scheduled_jobs() redaction. pg_cron commands
-- embed the anon JWT in an Authorization header; external schedule targets may
-- carry ?apikey= / token= query strings or bare JWTs. Three layers, applied
-- before truncation so the marker survives the cut: `Bearer <token>`, any bare
-- JWT literal (eyJ...), and key=value / key: value shapes for apikey, key,
-- token, secret. Only the redaction changes from 20261014204924.
create or replace function lume_scheduled_jobs() returns json
language sql security definer set search_path = public, pg_catalog stable as $$
  with pg as (
    select j.jobname as name, j.schedule as cron, 'pg_cron'::text as runner, j.active,
           j.command as target,
           (select r.status from cron.job_run_details r where r.jobid = j.jobid order by r.start_time desc limit 1) as last_status,
           (select r.start_time from cron.job_run_details r where r.jobid = j.jobid order by r.start_time desc limit 1) as last_run_at
    from cron.job j),
  ext as (
    select name, cron, runner, true as active, target, last_status, last_run_at from lume_external_schedules),
  rules as (
    select 'rule: ' || name, cron, 'rotation_rule', active, campaign_id, last_result->>'status', last_run_at from rotation_rules),
  all_rows as (select * from pg union all select * from ext union all select * from rules)
  select coalesce(json_agg(row_to_json(x)), '[]'::json)
  from (select name, cron, runner, active,
               left(regexp_replace(
                 regexp_replace(
                   regexp_replace(
                     regexp_replace(target, 'Bearer [A-Za-z0-9._=-]+', 'Bearer <redacted>', 'g'),
                     'eyJ[A-Za-z0-9._-]+', '<redacted>', 'g'),
                   '((api[_-]?key|token|secret|key)["'']?\s*[:=]\s*["'']?)[A-Za-z0-9._=-]+', '\1<redacted>', 'gi'),
                 '\s+', ' ', 'g'), 240) as target,
               last_status, last_run_at
        from all_rows) x;
$$;
revoke all on function lume_scheduled_jobs() from public, anon, authenticated;
grant execute on function lume_scheduled_jobs() to service_role;
