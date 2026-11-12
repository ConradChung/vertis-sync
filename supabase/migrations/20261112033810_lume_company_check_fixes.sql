-- validation_jobs.column_order is jsonb (an array of header strings), not text[].
create or replace function public.company_check_columns(p_job_id uuid) returns jsonb
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare
  hdrs text[];
  norm text[];
  co text; site text; mail text;
  i int;
begin
  select array(select jsonb_array_elements_text(column_order)) into hdrs
    from public.validation_jobs where id = p_job_id and jsonb_typeof(column_order) = 'array';
  if hdrs is null or cardinality(hdrs) = 0 then
    select array_agg(k) into hdrs from (
      select jsonb_object_keys(row_data) as k from (
        select row_data from public.validation_rows where job_id = p_job_id and jsonb_typeof(row_data) = 'object' limit 1
      ) one
    ) s;
  end if;
  if hdrs is null or cardinality(hdrs) = 0 then return jsonb_build_object('company', null, 'website', null, 'email', null); end if;
  select array_agg(regexp_replace(lower(btrim(h)), '\s+', '_', 'g') order by o) into norm from unnest(hdrs) with ordinality as t(h, o);
  for i in 1 .. cardinality(hdrs) loop
    if co is null and norm[i] in ('company_name', 'company', 'business_name', 'organization') then co := hdrs[i]; end if;
    if site is null and norm[i] in ('website', 'domain', 'url', 'web') then site := hdrs[i]; end if;
    if mail is null and norm[i] in ('email', 'email_address', 'work_email') then mail := hdrs[i]; end if;
  end loop;
  for i in 1 .. cardinality(hdrs) loop
    if co is null and (norm[i] like '%company%' or norm[i] like '%business_name%') then co := hdrs[i]; end if;
    if site is null and (norm[i] like '%website%' or norm[i] like '%domain%') then site := hdrs[i]; end if;
    if mail is null and norm[i] like '%email%' and norm[i] not like '%status%' and norm[i] not like '%sent%' then mail := hdrs[i]; end if;
  end loop;
  if co is null then
    for i in 1 .. cardinality(hdrs) loop
      if norm[i] = 'name' then co := hdrs[i]; exit; end if;
    end loop;
  end if;
  return jsonb_build_object('company', co, 'website', site, 'email', mail);
end $$;
revoke all on function public.company_check_columns(uuid) from public, anon, authenticated;
grant execute on function public.company_check_columns(uuid) to service_role;
