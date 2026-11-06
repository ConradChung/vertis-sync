-- Column cap follow-up. Rows keep every flattened field (cells, safety cap 300
-- keys); `all_columns` lists them all (first-seen order), `columns` stays the
-- ≤ 100 shown ones (chosen by fill rate across row types).
alter table public.lead_review_sets
  add column if not exists all_columns jsonb not null default '[]'::jsonb check (jsonb_typeof(all_columns) = 'array');

-- lume_summarize_lead_set gains p_where: equality filters {column: value} (≤ 5),
-- e.g. {"type": "post"}, so profile / company rows don't inflate post counts.
drop function if exists public.lume_summarize_lead_set(uuid, text[], jsonb, text, int);
create or replace function public.lume_summarize_lead_set(
  p_set uuid, p_group_by text[] default '{}', p_metrics jsonb default '[]'::jsonb, p_status text default null, p_limit int default 100, p_where jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sel text := '';
  v_metrics text := '';
  v_group text := '';
  v_where text := '';
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_out jsonb;
  m jsonb;
  w record;
  i int := 0;
  v_op text;
  v_col text;
  v_num text;
begin
  if coalesce(array_length(p_group_by, 1), 0) > 5 then raise exception 'at most 5 group_by columns'; end if;
  if jsonb_typeof(coalesce(p_metrics, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_metrics, '[]'::jsonb)) > 10 then raise exception 'metrics: an array of at most 10'; end if;
  if jsonb_typeof(coalesce(p_where, '{}'::jsonb)) <> 'object' or (select count(*) from jsonb_object_keys(coalesce(p_where, '{}'::jsonb))) > 5 then raise exception 'where: an object of at most 5 columns'; end if;
  if p_status is not null and p_status not in ('kept', 'excluded') then raise exception 'bad status'; end if;

  for i in 1 .. coalesce(array_length(p_group_by, 1), 0) loop
    v_sel := v_sel || format('nullif(cells->>%L, '''') as g%s, ', p_group_by[i], i);
    v_group := v_group || case when i > 1 then ', ' else '' end || format('g%s', i);
  end loop;

  for w in select key, value from jsonb_each(coalesce(p_where, '{}'::jsonb)) loop
    v_where := v_where || format(' and coalesce(cells->>%L, '''') = %L', w.key, case when jsonb_typeof(w.value) = 'string' then w.value #>> '{}' else w.value::text end);
  end loop;

  i := 0;
  for m in select * from jsonb_array_elements(coalesce(p_metrics, '[]'::jsonb)) loop
    i := i + 1;
    v_op := m->>'op';
    v_col := m->>'column';
    if v_col is null or length(v_col) = 0 or length(v_col) > 200 then raise exception 'metric % needs a column', i; end if;
    v_num := format('case when (cells->>%1$L) ~ ''^\s*-?[0-9]+(\.[0-9]+)?\s*$'' then (cells->>%1$L)::numeric end', v_col);
    v_metrics := v_metrics || case v_op
      when 'count_distinct' then format(', count(distinct nullif(cells->>%L, '''')) as m%s', v_col, i)
      when 'sum' then format(', sum(%s) as m%s', v_num, i)
      when 'avg' then format(', round(avg(%s), 2) as m%s', v_num, i)
      when 'min' then format(', min(%s) as m%s', v_num, i)
      when 'max' then format(', max(%s) as m%s', v_num, i)
      else null end;
    if v_metrics is null then raise exception 'unknown metric op %', v_op; end if;
  end loop;

  execute format($q$
    with g as (
      select %s count(*) as n %s
      from public.lead_review_items
      where set_id = $1 and ($2::text is null or status = $2) %s
      %s
    ), r as (select g.*, row_number() over (order by n desc) as rn from g)
    select jsonb_build_object(
      'group_count', (select count(*) from g),
      'total_rows', (select coalesce(sum(n), 0) from g),
      'groups', coalesce((select jsonb_agg(to_jsonb(r) - 'rn' order by rn) from r where rn <= $3), '[]'::jsonb),
      'other', (select jsonb_build_object('groups', count(*), 'rows', coalesce(sum(n), 0)) from r where rn > $3)
    )$q$,
    v_sel, v_metrics, v_where, case when v_group = '' then '' else 'group by ' || v_group end)
  into v_out using p_set, p_status, v_limit;
  return v_out;
end;
$$;
revoke all on function public.lume_summarize_lead_set(uuid, text[], jsonb, text, int, jsonb) from public, anon, authenticated;
grant execute on function public.lume_summarize_lead_set(uuid, text[], jsonb, text, int, jsonb) to service_role;

-- Validation stats polish: (job_id, status) is a prefix of validation_rows_job_status_reason_idx.
drop index if exists public.idx_validation_rows_job_status;
