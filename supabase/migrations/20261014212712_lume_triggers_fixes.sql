-- supabase/migrations/20261014212712_lume_triggers_fixes.sql
-- Lume: review fixes on top of lume_triggers (20261014210421). That migration
-- is already applied live, so everything here is a replace-in-place and
-- re-runnable. Triggers keep their function OIDs across `create or replace`.
--
-- 1. lock_timeout = 1s on both trigger functions. A blocked `events` insert
--    (e.g. someone holding ACCESS EXCLUSIVE on events) now raises 55P03 after
--    a second instead of parking the writer; the handler catches it and the
--    writer's statement completes without the event.
-- 2. search_path = pg_catalog, public on every lume function, so a public
--    object can never shadow a catalog one.
-- 3. lume_overview() gains events_last_at, a canary for silent trigger
--    failures: if it stops moving while jobs run, the triggers are raising
--    warnings instead of rows.

create or replace function lume_event_on_change() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
set lock_timeout = '1s'
as $$
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
      -- payload.row is the whole row (about 1 KB for validation_jobs); the
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

create or replace function lume_gate_kind(tbl text, op text, n jsonb, o jsonb) returns text
language sql immutable set search_path = pg_catalog, public as $$
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

create or replace function lume_gate_opened() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
set lock_timeout = '1s'
as $$
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

-- Same body as 20261014210421; only the search_path order changes.
create or replace function lume_scheduled_jobs() returns json
language sql security definer set search_path = pg_catalog, public stable as $$
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

-- Same body as 20261014204924 plus events_last_at (and the search_path order).
create or replace function lume_overview() returns json
language sql security definer set search_path = pg_catalog, public stable as $$
  select json_build_object(
    'now', now(),
    'pending_gates', (select count(*) from lume_gates),
    'replies_today', (select count(*) from events where type = 'reply'
                        and created_at > (date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles')),
    'bounces_24h', (select count(*) from events where type = 'bounce' and created_at > now() - interval '24 hours'),
    'active_jobs', (select count(*) from validation_jobs where status in ('pending','processing')),
    'lead_bank_queued', (select count(*) from lead_bank where state = 'queued'),
    -- canary: should move whenever a watched column changes anywhere
    'events_last_at', (select max(created_at) from events),
    'recent_events', (select coalesce(json_agg(e order by e.created_at desc), '[]'::json)
                      from (select * from events order by created_at desc limit 50) e)
  );
$$;
revoke all on function lume_overview() from public, anon, authenticated;
grant execute on function lume_overview() to service_role;
