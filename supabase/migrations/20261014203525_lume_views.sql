-- supabase/migrations/20261014203525_lume_views.sql
-- Read models for Lume. Views, never copies: the pipelines keep writing their
-- own tables and Lume sees the change on the next query / Realtime event.
-- Everything here is re-runnable (create or replace / if not exists).

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
  from validation_jobs j where j.finder_status = 'awaiting_decision'
union all
  select 'campaign_choice', 'validation_jobs', j.id::text, j.filename,
         format('%s valid leads · pick an Instantly campaign', j.valid_count),
         array['pick_campaign','push_cancel'],
         jsonb_build_object('valid_count', j.valid_count, 'candidates', j.instantly_campaign_candidates),
         j.instantly_prompt_message_id, j.updated_at
  from validation_jobs j where j.instantly_status in ('awaiting_campaign','choosing_campaign')
union all
  select 'push_review', 'validation_jobs', j.id::text, j.filename,
         format('%s valid → %s', j.valid_count, j.instantly_campaign_name),
         array['bar_loc','bar_co','push_strict','push_std','push_go','push_cancel'],
         jsonb_build_object('valid_count', j.valid_count, 'campaign_id', j.instantly_campaign_id, 'campaign_name', j.instantly_campaign_name,
                            'location_barrier', j.location_barrier, 'company_barrier', j.company_barrier, 'company_strict', j.company_strict,
                            'nolocation_campaign_id', j.instantly_campaign_id_nolocation),
         null::bigint, j.updated_at
  from validation_jobs j where j.instantly_status in ('configuring','reviewing_company')
union all
  select 'stall', 'validation_jobs', j.id::text, j.filename,
         format('stalled at %s/%s', j.processed_rows, j.total_rows),
         array['wd_resume'],
         jsonb_build_object('processed_rows', j.processed_rows, 'total_rows', j.total_rows, 'status', j.status),
         null::bigint, j.watchdog_notified_at
  from validation_jobs j where j.watchdog_status = 'awaiting'
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
  from job_batches b where b.watchdog_status = 'awaiting'
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

create or replace view lume_orders as
  select 'ingest'::text as kind, i.id::text as id, i.sender_platform as source, i.filename as summary,
         i.row_count, i.status, null::numeric as cost_usd,
         coalesce(i.sender_name, i.sender_platform) as created_by, i.validation_job_id, i.created_at
  from telegram_ingests i
union all
  select 'apollo_order', o.id::text, 'apollo_link', coalesce(o.apollo_url, format('Leadsfriday #%s', o.leadsfriday_order_id)),
         o.contact_count, o.status, o.credits_deducted, 'owner', (select validation_job_id from telegram_ingests t where t.id = o.ingest_id), o.created_at
  from apollo_orders o
union all
  select 'job_batch', b.id::text, 'leadsfriday', format('Job scrape %s · %s companies', b.batch_date, b.companies_pulled),
         b.contacts_total, b.status, null, 'scheduled task', null, b.created_at
  from job_batches b
union all
  select 'dashboard_job', j.id::text, j.source, j.filename, j.total_rows, j.status, null, 'dashboard', j.id, j.created_at
  from validation_jobs j where j.source in ('csv','apify','hnwi');

-- Validated, not yet assigned anywhere. Two sources: the rotation bank's own
-- queue, and valid rows from finished jobs that were never pushed.
-- row_data keys vary by source (Apollo exports: "First Name"; Apify: first_name),
-- hence the coalesce lists.
create or replace view lume_lead_bank as
  select 'lead_bank'::text as origin, l.id::text as id, l.email, l.first_name, l.last_name, l.company_name,
         l.location as city, null::text as icp_status, l.campaign_id, l.state, l.created_at
  from lead_bank l where l.state = 'queued'
union all
  select 'validation_rows', r.id::text, r.email,
         coalesce(r.row_data->>'First Name', r.row_data->>'first_name'),
         coalesce(r.row_data->>'Last Name',  r.row_data->>'last_name'),
         coalesce(r.row_data->>'Company Name', r.row_data->>'company_name', r.row_data->>'Company'),
         r.row_data->>'operating_city', r.row_data->>'icp_status', null, 'unassigned', r.processed_at
  from validation_rows r
  join validation_jobs j on j.id = r.job_id
  where r.status = 'valid' and r.instantly_status = 'skipped' and j.status = 'completed'
    and not exists (select 1 from lead_bank l where lower(l.email) = lower(r.email));
-- The not-exists above probes lead_bank by lower(email); give it an index (2.2k rows, additive).
create index if not exists lead_bank_lower_email_idx on lead_bank (lower(email));

-- The views are owned by postgres and are not security_invoker, so a grant to
-- the API roles would expose RLS-less pipeline tables through them. Supabase's
-- default privileges hand every new relation to anon/authenticated/service_role;
-- strip the two browser roles and keep service_role (Lume's server routes).
revoke all on lume_gates, lume_orders, lume_lead_bank from public, anon, authenticated;
grant select on lume_gates, lume_orders, lume_lead_bank to service_role;

-- cron.job is not readable by the API roles; expose it the way rotation_dashboard() does.
create or replace function lume_scheduled_jobs() returns json
language sql security definer set search_path = public, pg_catalog stable as $$
  with pg as (
    select j.jobname as name, j.schedule as cron, 'pg_cron'::text as runner, j.active,
           left(j.command, 160) as target,
           (select r.status from cron.job_run_details r where r.jobid = j.jobid order by r.start_time desc limit 1) as last_status,
           (select r.start_time from cron.job_run_details r where r.jobid = j.jobid order by r.start_time desc limit 1) as last_run_at
    from cron.job j),
  ext as (
    select name, cron, runner, true as active, target, last_status, last_run_at from lume_external_schedules),
  rules as (
    select 'rule: ' || name, cron, 'rotation_rule', active, campaign_id, last_result->>'status', last_run_at from rotation_rules)
  select coalesce(json_agg(row_to_json(x)), '[]'::json)
  from (select * from pg union all select * from ext union all select * from rules) x;
$$;
-- `from public` alone leaves Supabase's default grant to anon/authenticated in place (Task 1).
revoke all on function lume_scheduled_jobs() from public, anon, authenticated;
grant execute on function lume_scheduled_jobs() to service_role;

-- One round trip for the KPI tiles that come from the DB.
create or replace function lume_overview() returns json
language sql security definer set search_path = public, pg_catalog stable as $$
  select json_build_object(
    'now', now(),
    'pending_gates', (select count(*) from lume_gates),
    'replies_today', (select count(*) from events where type = 'reply' and created_at > date_trunc('day', now())),
    'bounces_24h', (select count(*) from events where type = 'bounce' and created_at > now() - interval '24 hours'),
    'active_jobs', (select count(*) from validation_jobs where status in ('pending','processing')),
    'lead_bank_queued', (select count(*) from lead_bank where state = 'queued'),
    'recent_events', (select coalesce(json_agg(e order by e.created_at desc), '[]'::json)
                      from (select * from events order by created_at desc limit 50) e)
  );
$$;
revoke all on function lume_overview() from public, anon, authenticated;
grant execute on function lume_overview() to service_role;
