-- Rewrites company_name on queued, never-pushed lead_bank rows in one call
-- (instantly-push mode 'reclean_bank', after the company-name SOP changed).
-- p_rows is a JSON array of {id, company_name}. Rows already in Instantly
-- (pushed_at set, or any state but queued) are never touched. Returns the
-- number of rows changed.
create or replace function public.lead_bank_set_company_names(p_rows jsonb)
returns integer
language sql
set search_path = public
as $$
  with src as (
    select (r->>'id')::bigint as id, nullif(trim(r->>'company_name'), '') as company_name
    from jsonb_array_elements(p_rows) r
  ), upd as (
    update public.lead_bank lb
       set company_name = src.company_name, updated_at = now()
      from src
     where lb.id = src.id
       and lb.state = 'queued'
       and lb.pushed_at is null
       and lb.company_name is distinct from src.company_name
    returning 1
  )
  select count(*)::int from upd
$$;

revoke all on function public.lead_bank_set_company_names(jsonb) from public, anon, authenticated;
grant execute on function public.lead_bank_set_company_names(jsonb) to service_role;
