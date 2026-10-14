-- supabase/migrations/20261014204924_lume_views_fixes.sql
-- Lume: review fixes on top of lume_views (20261014203525). That migration is
-- already applied live, so everything here is a replace-in-place and re-runnable.
--
-- 1. lume_gates: stall / finder / jobs_stall predicates mirror what
--    pipeline-watchdog itself scans (supabase/functions/pipeline-watchdog/index.ts:
--    validation_jobs status in (pending, processing); job_batches status in
--    (approved, resolving, ordered, delivered)). A completed or cancelled job
--    with a stale watchdog_status is not a stall. push_review hides behind an
--    awaiting pending action for the same job: the Validate screen shows the
--    lume_action card while the push waits for confirmation, and the executor
--    always puts job_id in payload.
-- 2. lume_scheduled_jobs(): redact bearer tokens before truncating.
-- 3. lume_overview(): replies_today is the owner's day, not UTC.
-- 4. Grants say what they mean: service_role gets select only on the views.

create or replace view lume_gates as
  select 'ingest_approval'::text as kind, 'telegram_ingests'::text as target_table, i.id::text as target_id,
         i.filename as title,
         format('%s rows · from %s · email column %s', i.row_count, coalesce(i.sender_name,'?'), coalesce(i.detected_email_column,'not detected')) as subtitle,
         case when i.detected_email_column is null then array['deny'] else array['approve','approve_enrich','deny'] end as actions,
         jsonb_build_object('row_count', i.row_count, 'sender_platform', i.sender_platform) as counts,
         i.telegram_message_id, i.created_at
  from telegram_ingests i where i.status = 'awaiting_approval'
union all
  select 'finder_decision', 'validation_jobs', j.id::text, j.filename,
         format('%s rows · %s without an email', j.total_rows, j.rows_missing_email),
         array['finder_go','finder_skip'],
         jsonb_build_object('total_rows', j.total_rows, 'rows_missing_email', j.rows_missing_email, 'enrich', j.enrich),
         null::bigint, j.created_at
  from validation_jobs j
  where j.finder_status = 'awaiting_decision' and j.status in ('pending','processing')
union all
  select 'campaign_choice', 'validation_jobs', j.id::text, j.filename,
         format('%s valid leads · pick an Instantly campaign', j.valid_count),
         array['pick_campaign','push_cancel'],
         jsonb_build_object('valid_count', j.valid_count, 'candidates', j.instantly_campaign_candidates),
         j.instantly_prompt_message_id, j.updated_at
  from validation_jobs j where j.instantly_status in ('awaiting_campaign','choosing_campaign')
union all
  -- Hidden while a push_to_instantly / launch_campaign action for this job is
  -- awaiting confirmation; the lume_action row below is the card for that.
  select 'push_review', 'validation_jobs', j.id::text, j.filename,
         format('%s valid → %s', j.valid_count, j.instantly_campaign_name),
         array['bar_loc','bar_co','push_strict','push_std','push_go','push_cancel'],
         jsonb_build_object('valid_count', j.valid_count, 'campaign_id', j.instantly_campaign_id, 'campaign_name', j.instantly_campaign_name,
                            'location_barrier', j.location_barrier, 'company_barrier', j.company_barrier, 'company_strict', j.company_strict,
                            'nolocation_campaign_id', j.instantly_campaign_id_nolocation),
         null::bigint, j.updated_at
  from validation_jobs j
  where j.instantly_status in ('configuring','reviewing_company')
    and not exists (select 1 from pending_actions a
                    where a.status = 'awaiting' and a.kind in ('push_to_instantly','launch_campaign')
                      and a.payload->>'job_id' = j.id::text)
union all
  select 'stall', 'validation_jobs', j.id::text, j.filename,
         format('stalled at %s/%s', j.processed_rows, j.total_rows),
         array['wd_resume'],
         jsonb_build_object('processed_rows', j.processed_rows, 'total_rows', j.total_rows, 'status', j.status),
         null::bigint, j.watchdog_notified_at
  from validation_jobs j
  where j.watchdog_status = 'awaiting' and j.status in ('pending','processing')
union all
  select 'jobs_review', 'job_batches', b.id::text, format('Job scrape %s', to_char(b.batch_date,'DD Mon')),
         format('%s companies added', b.companies_added),
         array['jobs_pull','jobs_skip'],
         jsonb_build_object('companies_added', b.companies_added, 'lookback_days', b.lookback_days),
         b.telegram_message_id, b.created_at
  from job_batches b where b.status = 'awaiting_review' and b.review_status = 'awaiting'
union all
  select 'jobs_fill', 'job_batches', b.id::text, format('Job batch %s', to_char(b.batch_date,'DD Mon')),
         format('%s companies resolved · below the 500-contact minimum', b.companies_pulled),
         array['jobs_order_now','jobs_abort'],
         jsonb_build_object('companies_pulled', b.companies_pulled, 'fill_rounds', b.fill_rounds),
         b.telegram_message_id, b.updated_at
  from job_batches b where b.status = 'waiting_fill'
union all
  select 'jobs_write', 'job_batches', b.id::text, format('Contacts ready · %s', to_char(b.batch_date,'DD Mon')),
         format('%s kept of %s', b.contacts_kept, b.contacts_total),
         array['jobs_write','jobs_discard'],
         jsonb_build_object('contacts_kept', b.contacts_kept, 'contacts_total', b.contacts_total, 'order_id', b.leadsfriday_order_id),
         null::bigint, b.updated_at
  from job_batches b where b.status = 'ranked' and b.write_status = 'awaiting'
union all
  select 'jobs_stall', 'job_batches', b.id::text, format('Job batch %s stalled', to_char(b.batch_date,'DD Mon')),
         format('at %s', b.status),
         array['jobs_resume','jobs_abort'],
         jsonb_build_object('status', b.status),
         null::bigint, b.watchdog_notified_at
  from job_batches b
  where b.watchdog_status = 'awaiting' and b.status in ('approved','resolving','ordered','delivered')
union all
  select 'lfo_count', 'apollo_orders', o.id::text, 'Apollo search → Leadsfriday',
         'How many contacts? Minimum 500',
         array['lfo_count','lfo_cancel'],
         jsonb_build_object('apollo_url', o.apollo_url),
         o.telegram_message_id, o.created_at
  from apollo_orders o where o.status = 'awaiting_count' and o.count_status = 'awaiting'
union all
  select 'lume_action', 'pending_actions', a.id::text, a.kind,
         coalesce(a.payload->>'summary', a.kind),
         array['lume_ok','lume_no'],
         a.payload,
         a.telegram_message_id, a.created_at
  from pending_actions a where a.status = 'awaiting';

-- Backs the push_review anti-join above.
create index if not exists pending_actions_job_idx
  on pending_actions ((payload->>'job_id')) where status = 'awaiting';

-- Views are not updatable, so the only privilege that means anything is select.
-- Supabase default privileges had handed service_role `all`; say what we mean.
revoke all on lume_gates, lume_orders, lume_lead_bank from public, anon, authenticated, service_role;
grant select on lume_gates, lume_orders, lume_lead_bank to service_role;

-- pg_cron commands embed the anon JWT in an Authorization header. Redact every
-- target (pg_cron commands, external schedule targets, rule campaign ids) in
-- the final select, before truncating, so the marker survives the cut. The
-- rotate commands are ~470 chars with the header past char 190, hence 240
-- after collapsing whitespace rather than 160.
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
               left(regexp_replace(regexp_replace(target, 'Bearer [A-Za-z0-9._-]+', 'Bearer <redacted>', 'g'), '\s+', ' ', 'g'), 240) as target,
               last_status, last_run_at
        from all_rows) x;
$$;
revoke all on function lume_scheduled_jobs() from public, anon, authenticated;
grant execute on function lume_scheduled_jobs() to service_role;

-- replies_today counts from the owner's midnight (America/Los_Angeles), not
-- UTC's. `now() at time zone 'America/Los_Angeles'` is LA wall-clock time as a
-- plain timestamp; date_trunc('day') gives LA midnight as a plain timestamp;
-- the second `at time zone` reads that back as LA local and yields the
-- timestamptz instant (07:00/08:00 UTC depending on DST), comparable to created_at.
create or replace function lume_overview() returns json
language sql security definer set search_path = public, pg_catalog stable as $$
  select json_build_object(
    'now', now(),
    'pending_gates', (select count(*) from lume_gates),
    'replies_today', (select count(*) from events where type = 'reply'
                        and created_at > (date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles')),
    'bounces_24h', (select count(*) from events where type = 'bounce' and created_at > now() - interval '24 hours'),
    'active_jobs', (select count(*) from validation_jobs where status in ('pending','processing')),
    'lead_bank_queued', (select count(*) from lead_bank where state = 'queued'),
    'recent_events', (select coalesce(json_agg(e order by e.created_at desc), '[]'::json)
                      from (select * from events order by created_at desc limit 50) e)
  );
$$;
revoke all on function lume_overview() from public, anon, authenticated;
grant execute on function lume_overview() to service_role;
