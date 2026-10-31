-- {{jurisdiction_line}} (a hook sentence) becomes {{compliance_law}}: just the
-- NAME of the compliance law the lead's place follows ("Residential Tenancies
-- Act, 2006"), resolved by the edge pushes from jurisdictions.compliance_name
-- (active rows with a name), else "local landlord-tenant law".
--
-- lead_bank.jurisdiction_line is renamed to compliance_law (an explicit
-- per-lead override, normally null; no row had a value). The lume_lead_bank
-- view is recreated so its output column is compliance_law too (create or
-- replace cannot rename a view column; nothing depends on the view).
--
-- Transition: the Lume deployed before this migration still names
-- jurisdiction_line when it reads lume_lead_bank and inserts into lead_bank.
-- So both keep a deprecated `jurisdiction_line` that is always null (the
-- table column only accepts null), until the next Lume deploy; then a later
-- migration drops them. Nothing reads it any more.
alter table public.lead_bank rename column jurisdiction_line to compliance_law;
alter table public.lead_bank rename constraint lead_bank_jurisdiction_line_check to lead_bank_compliance_law_check;
alter table public.lead_bank
  add column if not exists jurisdiction_line text check (jurisdiction_line is null);
comment on column public.lead_bank.jurisdiction_line is 'DEPRECATED, always null: kept so the Lume deployed before 20261030 compliance_law can still insert; drop after the next Lume deploy.';
comment on column public.lead_bank.compliance_law is 'Explicit {{compliance_law}} for this lead (a law name); null = resolved from jurisdictions at push time.';

drop view if exists public.lume_lead_bank;
create view public.lume_lead_bank as
  select 'lead_bank'::text as origin, l.id::text as id, l.email, l.first_name, l.last_name, l.company_name,
         l.location as city, null::text as icp_status, l.campaign_id, l.state, l.created_at,
         l.country, l.region, l.compliance_law, null::text as jurisdiction_line
  from lead_bank l where l.state = 'queued'
union all
  select 'validation_rows', r.id::text, r.email,
         coalesce(r.row_data->>'First Name', r.row_data->>'first_name'),
         coalesce(r.row_data->>'Last Name',  r.row_data->>'last_name'),
         coalesce(r.row_data->>'Company Name', r.row_data->>'company_name', r.row_data->>'Company'),
         r.row_data->>'operating_city', r.row_data->>'icp_status', null, 'unassigned', r.processed_at,
         coalesce(nullif(btrim(r.row_data->>'Country'), ''), nullif(btrim(r.row_data->>'Company Country'), '')),
         coalesce(nullif(btrim(r.row_data->>'State'), ''), nullif(btrim(r.row_data->>'Company State'), '')),
         null::text, null::text
  from validation_rows r
  join validation_jobs j on j.id = r.job_id
  where r.status = 'valid' and r.instantly_status = 'skipped' and j.status = 'completed'
    and not exists (select 1 from lead_bank l where lower(l.email) = lower(r.email));

-- Same grants as before: select for service_role only.
revoke all on public.lume_lead_bank from public, anon, authenticated, service_role;
grant select on public.lume_lead_bank to service_role;
