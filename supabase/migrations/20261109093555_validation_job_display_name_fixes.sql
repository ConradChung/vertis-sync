-- lume_validation_rows_search: prefilter on row_data::text (one string match per row,
-- ~5x faster on a 5k-row job) before the per-value check that drops key-only hits.
-- Exact as long as the term has no '"', '\' or control characters, which Lume strips
-- before building the pattern (lib/validate/preview.ts searchPattern).
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
        or (
          r.row_data::text ilike p_pattern
          and exists (
            select 1 from jsonb_each_text(case when jsonb_typeof(r.row_data) = 'object' then r.row_data else '{}'::jsonb end) e
            where e.value ilike p_pattern
          )
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
