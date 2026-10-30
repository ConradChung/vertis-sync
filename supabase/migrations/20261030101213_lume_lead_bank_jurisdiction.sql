-- Lume research P4 (minimal): carry a lead's country / region to the push.
--
-- lead_bank.country            ISO2, set only when the country is certain
--                              (normalizeCountry in _shared/research/jurisdiction.ts
--                              and its Lume mirror lib/copy/jurisdiction.ts).
-- lead_bank.region             canonical region name ("British Columbia"), only
--                              alongside a certain country.
-- lead_bank.jurisdiction_line  an explicit per-lead sentence. When set,
--                              instantly-rotate sends it as {{jurisdiction_line}}
--                              as is; when null, rotate resolves country/region
--                              against the active jurisdictions rows at push time
--                              and falls back to the client's SOP sentence.
--
-- lume_lead_bank gains the same three columns at the end (create or replace
-- may only append). The validation_rows branch exposes Apollo's raw Country /
-- Company Country and State / Company State; Lume normalises them before the
-- lead_bank insert. Additive and nullable: nothing existing changes.

alter table public.lead_bank
  add column if not exists country text check (country is null or country ~ '^[A-Z]{2}$'),
  add column if not exists region text check (region is null or length(region) <= 100),
  add column if not exists jurisdiction_line text check (jurisdiction_line is null or length(jurisdiction_line) <= 500);

create or replace view lume_lead_bank as
  select 'lead_bank'::text as origin, l.id::text as id, l.email, l.first_name, l.last_name, l.company_name,
         l.location as city, null::text as icp_status, l.campaign_id, l.state, l.created_at,
         l.country, l.region, l.jurisdiction_line
  from lead_bank l where l.state = 'queued'
union all
  select 'validation_rows', r.id::text, r.email,
         coalesce(r.row_data->>'First Name', r.row_data->>'first_name'),
         coalesce(r.row_data->>'Last Name',  r.row_data->>'last_name'),
         coalesce(r.row_data->>'Company Name', r.row_data->>'company_name', r.row_data->>'Company'),
         r.row_data->>'operating_city', r.row_data->>'icp_status', null, 'unassigned', r.processed_at,
         coalesce(nullif(btrim(r.row_data->>'Country'), ''), nullif(btrim(r.row_data->>'Company Country'), '')),
         coalesce(nullif(btrim(r.row_data->>'State'), ''), nullif(btrim(r.row_data->>'Company State'), '')),
         null::text
  from validation_rows r
  join validation_jobs j on j.id = r.job_id
  where r.status = 'valid' and r.instantly_status = 'skipped' and j.status = 'completed'
    and not exists (select 1 from lead_bank l where lower(l.email) = lower(r.email));

-- Same grants as lume_views_fixes: select for service_role only.
revoke all on lume_lead_bank from public, anon, authenticated, service_role;
grant select on lume_lead_bank to service_role;
