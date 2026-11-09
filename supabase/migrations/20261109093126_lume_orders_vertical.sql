-- Tags: Import's order list (lume_orders) carries each order's tag
-- (vertical_id) and the tag's name, appended as the last two columns so the
-- existing ones keep their position and meaning. Same rows.
create or replace view public.lume_orders as
 SELECT 'ingest'::text AS kind,
    (i.id)::text AS id,
    i.sender_platform AS source,
    i.filename AS summary,
    i.row_count,
    i.status,
    NULL::numeric AS cost_usd,
    COALESCE(i.sender_name, i.sender_platform) AS created_by,
    i.validation_job_id,
    i.created_at,
    i.vertical_id,
    (SELECT tv.name FROM lume_verticals tv WHERE tv.id = i.vertical_id) AS vertical_name
   FROM telegram_ingests i
UNION ALL
 SELECT 'apollo_order'::text AS kind,
    (o.id)::text AS id,
    'apollo_link'::text AS source,
    COALESCE(o.apollo_url, format('Leadsfriday #%s'::text, o.leadsfriday_order_id)) AS summary,
    o.contact_count AS row_count,
    o.status,
    o.credits_deducted AS cost_usd,
    'owner'::text AS created_by,
    ( SELECT t.validation_job_id
           FROM telegram_ingests t
          WHERE (t.id = o.ingest_id)) AS validation_job_id,
    o.created_at,
    o.vertical_id,
    (SELECT tv.name FROM lume_verticals tv WHERE tv.id = o.vertical_id) AS vertical_name
   FROM apollo_orders o
UNION ALL
 SELECT 'job_batch'::text AS kind,
    (b.id)::text AS id,
    'leadsfriday'::text AS source,
    format('Job scrape %s · %s companies'::text, b.batch_date, b.companies_pulled) AS summary,
    b.contacts_total AS row_count,
    b.status,
    NULL::numeric AS cost_usd,
    'scheduled task'::text AS created_by,
    NULL::uuid AS validation_job_id,
    b.created_at,
    b.vertical_id,
    (SELECT tv.name FROM lume_verticals tv WHERE tv.id = b.vertical_id) AS vertical_name
   FROM job_batches b
UNION ALL
 SELECT 'dashboard_job'::text AS kind,
    (j.id)::text AS id,
    j.source,
    j.filename AS summary,
    j.total_rows AS row_count,
    j.status,
    NULL::numeric AS cost_usd,
    'dashboard'::text AS created_by,
    j.id AS validation_job_id,
    j.created_at,
    j.vertical_id,
    (SELECT tv.name FROM lume_verticals tv WHERE tv.id = j.vertical_id) AS vertical_name
   FROM validation_jobs j
  WHERE (j.source = ANY (ARRAY['csv'::text, 'apify'::text, 'hnwi'::text]));
