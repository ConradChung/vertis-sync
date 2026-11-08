-- Backfill-on-read of lead_review_items.cells (sets loaded before cells existed):
-- cells_backfilled_at marks a set as attempted (so a set whose rows have no raw
-- is not re-scanned on every read), and lume_set_lead_cells writes ONLY the
-- cells column for one page of rows ([{idx, cells}]), never status /
-- excluded_reason / filter_id, so a concurrent filter is never reverted.
alter table public.lead_review_sets add column if not exists cells_backfilled_at timestamptz;

create or replace function public.lume_set_lead_cells(p_set uuid, p_rows jsonb)
returns int
language sql
security definer
set search_path = public
as $$
  with x as (
    select (e->>'idx')::int as idx, e->'cells' as cells
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e
    where jsonb_typeof(e->'cells') = 'object'
  ), u as (
    update public.lead_review_items i set cells = x.cells
    from x where i.set_id = p_set and i.idx = x.idx
    returning 1
  )
  select count(*)::int from u;
$$;
revoke all on function public.lume_set_lead_cells(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.lume_set_lead_cells(uuid, jsonb) to service_role;
