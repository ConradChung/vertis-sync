-- Lume: the owner can rename a validated list (null = show the filename / size title),
-- and search one job's rows by email or any original CSV value for the leads preview.
-- Additive only; the validator never reads display_name.
alter table public.validation_jobs add column if not exists display_name text
  check (display_name is null or char_length(display_name) between 1 and 120);

-- One page of a job's rows matching an ILIKE pattern (built and escaped by Lume,
-- passed as a parameter) on the email or any row_data value, row_index order,
-- plus the match count. p_status null = every status. Service role only.
create or replace function public.lume_validation_rows_search(p_job uuid, p_status text, p_pattern text, p_offset int default 0, p_limit int default 100)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with m as (
    select r.id, r.row_index, r.email, r.status, r.validation_result, r.enrichment_status, r.enrichment, r.instantly_status, r.row_data
    from public.validation_rows r
    where r.job_id = p_job
      and (p_status is null or r.status = p_status)
      and (
        r.email ilike p_pattern
        or exists (
          select 1 from jsonb_each_text(case when jsonb_typeof(r.row_data) = 'object' then r.row_data else '{}'::jsonb end) e
          where e.value ilike p_pattern
        )
      )
  )
  select jsonb_build_object(
    'total', (select count(*) from m),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.row_index, x.id)
      from (select * from m order by row_index, id offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 100), 1), 1000)) x
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.lume_validation_rows_search(uuid, text, text, int, int) from public, anon, authenticated;
grant execute on function public.lume_validation_rows_search(uuid, text, text, int, int) to service_role;
