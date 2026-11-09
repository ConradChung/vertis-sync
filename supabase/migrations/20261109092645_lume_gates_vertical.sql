-- Tags: every gate carries its item's tag (vertical_id) and the tag's name,
-- appended as the last two columns so every existing column keeps its
-- position and meaning (consumers select * or kind only). Same rows.
create or replace view public.lume_gates as
 SELECT 'ingest_approval'::text AS kind,
    'telegram_ingests'::text AS target_table,
    (i.id)::text AS target_id,
    format('%s leads · %s', to_char(coalesce(i.row_count, 0), 'FM999,999,999'), to_char(i.created_at, 'DD Mon')) AS title,
    format('%s · from %s · email column %s'::text, i.filename, COALESCE(i.sender_name, '?'::text), COALESCE(i.detected_email_column, 'not detected'::text)) AS subtitle,
        CASE
            WHEN (i.detected_email_column IS NULL) THEN ARRAY['deny'::text]
            ELSE ARRAY['approve'::text, 'approve_enrich'::text, 'deny'::text]
        END AS actions,
    jsonb_build_object('row_count', i.row_count, 'sender_platform', i.sender_platform) AS counts,
    i.telegram_message_id,
    i.created_at,
    i.vertical_id,
    (SELECT tv.name FROM lume_verticals tv WHERE tv.id = i.vertical_id) AS vertical_name
   FROM telegram_ingests i
  WHERE (i.status = 'awaiting_approval'::text)
UNION ALL
 SELECT 'finder_decision'::text AS kind,
    'validation_jobs'::text AS target_table,
    (j.id)::text AS target_id,
    format('%s leads · %s', to_char(coalesce(j.total_rows, 0), 'FM999,999,999'), to_char(j.created_at, 'DD Mon')) AS title,
    format('%s · %s without an email'::text, j.filename, j.rows_missing_email) AS subtitle,
    ARRAY['finder_go'::text, 'finder_skip'::text] AS actions,
    jsonb_build_object('total_rows', j.total_rows, 'rows_missing_email', j.rows_missing_email, 'enrich', j.enrich) AS counts,
    NULL::bigint AS telegram_message_id,
    j.created_at,
    j.vertical_id,
    (SELECT tv.name FROM lume_verticals tv WHERE tv.id = j.vertical_id) AS vertical_name
   FROM validation_jobs j
  WHERE ((j.finder_status = 'awaiting_decision'::text) AND (j.status = ANY (ARRAY['pending'::text, 'processing'::text])))
UNION ALL
 SELECT 'campaign_choice'::text AS kind,
    'validation_jobs'::text AS target_table,
    (j.id)::text AS target_id,
    format('%s valid leads · %s', to_char(coalesce(j.valid_count, 0), 'FM999,999,999'), to_char(j.created_at, 'DD Mon')) AS title,
    format('%s · pick an Instantly campaign'::text, j.filename) AS subtitle,
    ARRAY['pick_campaign'::text, 'push_cancel'::text] AS actions,
    jsonb_build_object('valid_count', j.valid_count, 'candidates', j.instantly_campaign_candidates) AS counts,
    j.instantly_prompt_message_id AS telegram_message_id,
    j.updated_at AS created_at,
    j.vertical_id,
    (SELECT tv.name FROM lume_verticals tv WHERE tv.id = j.vertical_id) AS vertical_name
   FROM validation_jobs j
  WHERE (j.instantly_status = ANY (ARRAY['awaiting_campaign'::text, 'choosing_campaign'::text]))
UNION ALL
 SELECT 'push_review'::text AS kind,
    'validation_jobs'::text AS target_table,
    (j.id)::text AS target_id,
    format('%s valid leads · %s', to_char(coalesce(j.valid_count, 0), 'FM999,999,999'), to_char(j.created_at, 'DD Mon')) AS title,
    format('%s → %s'::text, j.filename, j.instantly_campaign_name) AS subtitle,
    ARRAY['bar_loc'::text, 'bar_co'::text, 'push_strict'::text, 'push_std'::text, 'push_go'::text, 'push_cancel'::text] AS actions,
    jsonb_build_object('valid_count', j.valid_count, 'campaign_id', j.instantly_campaign_id, 'campaign_name', j.instantly_campaign_name, 'location_barrier', j.location_barrier, 'company_barrier', j.company_barrier, 'company_strict', j.company_strict, 'nolocation_campaign_id', j.instantly_campaign_id_nolocation) AS counts,
    NULL::bigint AS telegram_message_id,
    j.updated_at AS created_at,
    j.vertical_id,
    (SELECT tv.name FROM lume_verticals tv WHERE tv.id = j.vertical_id) AS vertical_name
   FROM validation_jobs j
  WHERE ((j.instantly_status = ANY (ARRAY['configuring'::text, 'reviewing_company'::text])) AND (NOT (EXISTS ( SELECT 1
           FROM pending_actions a
          WHERE ((a.status = 'awaiting'::text) AND (a.kind = ANY (ARRAY['push_to_instantly'::text, 'launch_campaign'::text])) AND ((a.payload ->> 'job_id'::text) = (j.id)::text))))))
UNION ALL
 SELECT 'stall'::text AS kind,
    'validation_jobs'::text AS target_table,
    (j.id)::text AS target_id,
    format('%s leads · %s', to_char(coalesce(j.total_rows, 0), 'FM999,999,999'), to_char(j.created_at, 'DD Mon')) AS title,
    format('%s · stalled at %s/%s'::text, j.filename, j.processed_rows, j.total_rows) AS subtitle,
    ARRAY['wd_resume'::text] AS actions,
    jsonb_build_object('processed_rows', j.processed_rows, 'total_rows', j.total_rows, 'status', j.status) AS counts,
    NULL::bigint AS telegram_message_id,
    j.watchdog_notified_at AS created_at,
    j.vertical_id,
    (SELECT tv.name FROM lume_verticals tv WHERE tv.id = j.vertical_id) AS vertical_name
   FROM validation_jobs j
  WHERE ((j.watchdog_status = 'awaiting'::text) AND (j.status = ANY (ARRAY['pending'::text, 'processing'::text])))
UNION ALL
 SELECT 'jobs_review'::text AS kind,
    'job_batches'::text AS target_table,
    (b.id)::text AS target_id,
    format('%s companies · %s', to_char(coalesce(b.companies_added, 0), 'FM999,999,999'), to_char(b.created_at, 'DD Mon')) AS title,
    format('Job scrape of %s'::text, to_char((b.batch_date)::timestamp with time zone, 'DD Mon'::text)) AS subtitle,
    ARRAY['jobs_pull'::text, 'jobs_skip'::text] AS actions,
    jsonb_build_object('companies_added', b.companies_added, 'lookback_days', b.lookback_days) AS counts,
    b.telegram_message_id,
    b.created_at,
    b.vertical_id,
    (SELECT tv.name FROM lume_verticals tv WHERE tv.id = b.vertical_id) AS vertical_name
   FROM job_batches b
  WHERE ((b.status = 'awaiting_review'::text) AND (b.review_status = 'awaiting'::text))
UNION ALL
 SELECT 'jobs_fill'::text AS kind,
    'job_batches'::text AS target_table,
    (b.id)::text AS target_id,
    format('%s companies · %s', to_char(coalesce(b.companies_pulled, 0), 'FM999,999,999'), to_char(b.updated_at, 'DD Mon')) AS title,
    format('Job scrape of %s · below the 500-contact minimum'::text, to_char((b.batch_date)::timestamp with time zone, 'DD Mon'::text)) AS subtitle,
    ARRAY['jobs_order_now'::text, 'jobs_abort'::text] AS actions,
    jsonb_build_object('companies_pulled', b.companies_pulled, 'fill_rounds', b.fill_rounds) AS counts,
    b.telegram_message_id,
    b.updated_at AS created_at,
    b.vertical_id,
    (SELECT tv.name FROM lume_verticals tv WHERE tv.id = b.vertical_id) AS vertical_name
   FROM job_batches b
  WHERE (b.status = 'waiting_fill'::text)
UNION ALL
 SELECT 'jobs_write'::text AS kind,
    'job_batches'::text AS target_table,
    (b.id)::text AS target_id,
    format('%s leads · %s', to_char(coalesce(b.contacts_kept, 0), 'FM999,999,999'), to_char(b.updated_at, 'DD Mon')) AS title,
    format('%s kept of %s · job scrape of %s'::text, b.contacts_kept, b.contacts_total, to_char((b.batch_date)::timestamp with time zone, 'DD Mon'::text)) AS subtitle,
    ARRAY['jobs_write'::text, 'jobs_discard'::text] AS actions,
    jsonb_build_object('contacts_kept', b.contacts_kept, 'contacts_total', b.contacts_total, 'order_id', b.leadsfriday_order_id) AS counts,
    NULL::bigint AS telegram_message_id,
    b.updated_at AS created_at,
    b.vertical_id,
    (SELECT tv.name FROM lume_verticals tv WHERE tv.id = b.vertical_id) AS vertical_name
   FROM job_batches b
  WHERE ((b.status = 'ranked'::text) AND (b.write_status = 'awaiting'::text))
UNION ALL
 SELECT 'jobs_stall'::text AS kind,
    'job_batches'::text AS target_table,
    (b.id)::text AS target_id,
    format('%s companies · %s', to_char(coalesce(nullif(b.companies_pulled, 0), b.companies_added, 0), 'FM999,999,999'), to_char(b.updated_at, 'DD Mon')) AS title,
    format('Job scrape of %s · stalled at %s%s'::text, to_char((b.batch_date)::timestamp with time zone, 'DD Mon'::text), b.status,
      CASE WHEN b.leadsfriday_order_id IS NOT NULL THEN format(' · Leadsfriday #%s', b.leadsfriday_order_id) ELSE '' END) AS subtitle,
    ARRAY['jobs_resume'::text, 'jobs_abort'::text] AS actions,
    jsonb_build_object('status', b.status) AS counts,
    NULL::bigint AS telegram_message_id,
    b.watchdog_notified_at AS created_at,
    b.vertical_id,
    (SELECT tv.name FROM lume_verticals tv WHERE tv.id = b.vertical_id) AS vertical_name
   FROM job_batches b
  WHERE ((b.watchdog_status = 'awaiting'::text) AND (b.status = ANY (ARRAY['approved'::text, 'resolving'::text, 'ordered'::text, 'delivered'::text])))
UNION ALL
 SELECT 'lfo_count'::text AS kind,
    'apollo_orders'::text AS target_table,
    (o.id)::text AS target_id,
    'Apollo search → Leadsfriday'::text AS title,
    'How many contacts? Minimum 500'::text AS subtitle,
    ARRAY['lfo_count'::text, 'lfo_cancel'::text] AS actions,
    jsonb_build_object('apollo_url', o.apollo_url) AS counts,
    o.telegram_message_id,
    o.created_at,
    o.vertical_id,
    (SELECT tv.name FROM lume_verticals tv WHERE tv.id = o.vertical_id) AS vertical_name
   FROM apollo_orders o
  WHERE ((o.status = 'awaiting_count'::text) AND (o.count_status = 'awaiting'::text))
UNION ALL
 SELECT 'lume_action'::text AS kind,
    'pending_actions'::text AS target_table,
    (a.id)::text AS target_id,
    a.kind AS title,
    COALESCE((a.payload ->> 'summary'::text), a.kind) AS subtitle,
    ARRAY['lume_ok'::text, 'lume_no'::text] AS actions,
    a.payload AS counts,
    a.telegram_message_id,
    a.created_at,
    a.vertical_id,
    (SELECT tv.name FROM lume_verticals tv WHERE tv.id = a.vertical_id) AS vertical_name
   FROM pending_actions a
  WHERE (a.status = 'awaiting'::text);
