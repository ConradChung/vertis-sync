-- Company check v2: one call now also returns the property type and door
-- count; runs get a scope.
--
-- company_checks        + property_type (residential | multifamily |
--                       commercial | mixed | other | unknown), doors (null =
--                       unknown), doors_evidence.
-- company_check_runs    + scope: 'all' = every valid row of the job;
--                       'sending' = only valid rows whose email still sits in
--                       the lead bank for this job in state queued or active
--                       (leads already pulled, state skipped, are left out).
--                       The scope is part of the run's identity: unique
--                       (job_id, icp_key, scope).
-- company_check_scoped_rows(job, scope)   the one place the scope filter lives
--                       (used by plan and seed).
-- company_check_plan(job, icp, scope default 'all')   replaces the 2-arg version.
-- company_check_open_run(job, icp, scope default 'all') replaces the 2-arg version.
-- company_check_seed    seeds the run's scope; a company that left the scope
--                       is dropped while unchecked, else kept with 0 leads.
-- company_check_summary + companies_by_type, leads_by_type.
-- company_check_results + property_type, doors, doors_evidence, scope.
-- All functions stay service_role only.

alter table public.company_checks
  add column property_type text check (property_type is null or property_type in ('residential', 'multifamily', 'commercial', 'mixed', 'other', 'unknown')),
  add column doors int check (doors is null or doors >= 0),
  add column doors_evidence text check (doors_evidence is null or length(doors_evidence) <= 500);

alter table public.company_check_runs
  add column scope text not null default 'all' check (scope in ('all', 'sending'));
alter table public.company_check_runs drop constraint company_check_runs_job_id_icp_key_key;
alter table public.company_check_runs add constraint company_check_runs_job_icp_scope_key unique (job_id, icp_key, scope);

create or replace view public.company_check_results with (security_invoker = true) as
  select i.run_id, r.job_id, i.company_key, i.company_name, i.website, i.leads, i.status, i.attempts, i.error,
         c.what_it_does, c.icp_fit, c.confidence, c.evidence, c.evidence_url, c.checked_at, c.cost_usd as check_cost_usd,
         c.property_type, c.doors, c.doors_evidence, r.scope
    from public.company_check_items i
    join public.company_check_runs r on r.id = i.run_id
    left join public.company_checks c on c.company_key = i.company_key and c.icp_key = r.icp_key;
revoke all on public.company_check_results from anon, authenticated;

-- The job's valid rows in a scope, keyed: company key, company, website, the
-- enrichment icp_status. 'sending' keeps a row only while its email is in the
-- lead bank for this job as queued or active.
create or replace function public.company_check_scoped_rows(p_job_id uuid, p_scope text)
returns table (k text, co text, site text, icp_status text)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare
  cols jsonb := public.company_check_columns(p_job_id);
begin
  if p_scope is null or p_scope not in ('all', 'sending') then
    raise exception 'company_check: scope must be all or sending, got %', p_scope;
  end if;
  return query
    with bank as (
      select distinct lower(btrim(b.email)) as e
        from public.lead_bank b
       where p_scope = 'sending' and b.source_job_id = p_job_id and b.state in ('queued', 'active') and b.email is not null
    )
    select public.company_check_key(v.row_data ->> (cols ->> 'website'), v.row_data ->> (cols ->> 'email'), v.row_data ->> (cols ->> 'company')),
           nullif(btrim(v.row_data ->> (cols ->> 'company')), ''),
           nullif(btrim(v.row_data ->> (cols ->> 'website')), ''),
           v.enrichment ->> 'icp_status'
      from public.validation_rows v
     where v.job_id = p_job_id and v.status = 'valid'
       and (p_scope = 'all' or lower(btrim(v.row_data ->> (cols ->> 'email'))) in (select e from bank));
end $$;

drop function if exists public.company_check_plan(uuid, text);
create function public.company_check_plan(p_job_id uuid, p_icp text, p_scope text default 'all') returns jsonb
language plpgsql stable
set search_path = pg_catalog, public, extensions
as $$
declare
  ikey text := public.company_check_icp_key(p_icp);
  out jsonb;
begin
  with v as (
    select * from public.company_check_scoped_rows(p_job_id, p_scope)
  ), ks as (
    select distinct k from v where k is not null
  )
  select jsonb_build_object(
    'icp_key', ikey,
    'scope', p_scope,
    'columns', public.company_check_columns(p_job_id),
    'valid_leads', (select count(*) from v),
    'all_valid_leads', (select count(*) from public.validation_rows where job_id = p_job_id and status = 'valid'),
    'bank_leads', (select count(*) from public.lead_bank where source_job_id = p_job_id),
    'leads_without_company', (select count(*) from v where k is null),
    'companies', (select count(*) from ks),
    'companies_by_domain', (select count(*) from ks where k not like 'name:%'),
    'companies_by_name_only', (select count(*) from ks where k like 'name:%'),
    'cached', (select count(*) from ks join public.company_checks c on c.company_key = ks.k and c.icp_key = ikey),
    'enrichment_icp_status', coalesce((select jsonb_object_agg(coalesce(icp_status, 'none'), n) from (
       select icp_status, count(*) as n from v group by icp_status) s), '{}'::jsonb)
  ) into out;
  return out;
end $$;

drop function if exists public.company_check_open_run(uuid, text);
create function public.company_check_open_run(p_job_id uuid, p_icp text, p_scope text default 'all') returns public.company_check_runs
language plpgsql
set search_path = pg_catalog, public, extensions
as $$
declare
  ikey text := public.company_check_icp_key(p_icp);
  sc text := coalesce(p_scope, 'all');
  r public.company_check_runs;
begin
  insert into public.company_check_runs (job_id, icp_description, icp_key, scope)
  values (p_job_id, btrim(p_icp), ikey, sc)
  on conflict (job_id, icp_key, scope) do nothing;
  select * into r from public.company_check_runs where job_id = p_job_id and icp_key = ikey and scope = sc;
  return r;
end $$;

create or replace function public.company_check_summary(p_run_id uuid) returns jsonb
language sql stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_object_agg(status, n) from (
        select status, count(*) as n from public.company_check_items where run_id = p_run_id group by status) s), '{}'::jsonb),
    'companies_by_fit', coalesce((select jsonb_object_agg(icp_fit, n) from (
        select icp_fit, count(*) as n from public.company_check_results where run_id = p_run_id and icp_fit is not null group by icp_fit) s), '{}'::jsonb),
    'leads_by_fit', coalesce((select jsonb_object_agg(icp_fit, n) from (
        select icp_fit, sum(leads) as n from public.company_check_results where run_id = p_run_id and icp_fit is not null group by icp_fit) s), '{}'::jsonb),
    'companies_by_type', coalesce((select jsonb_object_agg(t, n) from (
        select coalesce(property_type, 'unknown') as t, count(*) as n from public.company_check_results where run_id = p_run_id and icp_fit is not null group by 1) s), '{}'::jsonb),
    'leads_by_type', coalesce((select jsonb_object_agg(t, n) from (
        select coalesce(property_type, 'unknown') as t, sum(leads) as n from public.company_check_results where run_id = p_run_id and icp_fit is not null group by 1) s), '{}'::jsonb)
  )
$$;

-- Seed a run's companies from its scope (idempotent: new companies added,
-- lead counts refreshed; a company no longer in scope is dropped while still
-- unchecked, else kept with 0 leads), mark cached ones, retry failed ones.
create or replace function public.company_check_seed(p_run_id uuid) returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  r public.company_check_runs;
  total int;
  keys text[];
begin
  select * into r from public.company_check_runs where id = p_run_id;
  if r.id is null then raise exception 'company_check_seed: run % not found', p_run_id; end if;
  with s as (
    select k, left(max(co), 500) as co, left(max(site), 500) as site, count(*) as n
      from public.company_check_scoped_rows(r.job_id, r.scope)
     where k is not null
     group by k
  ), ins as (
    insert into public.company_check_items (run_id, company_key, company_name, website, leads)
    select p_run_id, k, co, site, n from s
    on conflict (run_id, company_key) do update set leads = excluded.leads
    returning company_key
  )
  select coalesce(array_agg(company_key), '{}') into keys from ins;
  delete from public.company_check_items i
   where i.run_id = p_run_id and i.status in ('pending', 'error') and not (i.company_key = any (keys));
  update public.company_check_items i set leads = 0
   where i.run_id = p_run_id and i.leads <> 0 and not (i.company_key = any (keys));
  update public.company_check_items i set status = 'cached', updated_at = now()
   where i.run_id = p_run_id and i.status in ('pending', 'error')
     and exists (select 1 from public.company_checks c where c.company_key = i.company_key and c.icp_key = r.icp_key);
  update public.company_check_items set status = 'pending', attempts = 0, updated_at = now()
   where run_id = p_run_id and status = 'error';
  select count(*) into total from public.company_check_items where run_id = p_run_id;
  update public.company_check_runs set companies_total = total, updated_at = now() where id = p_run_id;
  return public.company_check_summary(p_run_id);
end $$;

revoke all on function public.company_check_scoped_rows(uuid, text) from public, anon, authenticated;
revoke all on function public.company_check_plan(uuid, text, text) from public, anon, authenticated;
revoke all on function public.company_check_open_run(uuid, text, text) from public, anon, authenticated;
revoke all on function public.company_check_seed(uuid) from public, anon, authenticated;
revoke all on function public.company_check_summary(uuid) from public, anon, authenticated;
grant execute on function public.company_check_scoped_rows(uuid, text), public.company_check_plan(uuid, text, text),
  public.company_check_open_run(uuid, text, text), public.company_check_seed(uuid), public.company_check_summary(uuid) to service_role;
