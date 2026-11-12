-- The validated-leads preview with each row's sending state, read from the
-- lead bank (the job's own bank rows, by email) or the direct-push status on
-- validation_rows. Read-only; Lume's "In progress" table filters on it.
create or replace function public.lume_validation_rows_page(
  p_job uuid,
  p_status text,
  p_send text,
  p_pattern text,
  p_offset integer default 0,
  p_limit integer default 100
) returns jsonb
language sql stable security definer
set search_path to 'public'
as $$
  with bank as (
    select distinct on (lower(b.email)) lower(b.email) as em, b.state, b.pushed_at, b.company_name, b.campaign_id
    from public.lead_bank b
    where b.source_job_id = p_job
    order by lower(b.email), (b.state = 'skipped' and b.pushed_at is null), b.id desc
  ),
  base as (
    select r.id, r.row_index, r.email, r.status, r.validation_result, r.enrichment_status, r.enrichment, r.instantly_status, r.row_data,
      b.company_name as bank_company,
      b.campaign_id as send_campaign_id,
      case
        when b.state = 'queued' then 'queued'
        when b.state = 'active' then 'in_instantly'
        when b.state = 'replied' then 'replied'
        when b.state = 'skipped' and b.pushed_at is null then 'pulled'
        when b.state in ('completed', 'skipped') then 'finished'
        when b.state in ('bounced', 'unsubscribed') then b.state
        when r.instantly_status = 'pushed' then 'in_instantly'
        when r.instantly_status = 'filtered' then 'filtered'
        else 'not_sent'
      end as send_state
    from public.validation_rows r
    left join bank b on b.em = lower(r.email)
    where r.job_id = p_job
      and (p_status is null or r.status = p_status)
  ),
  m as (
    select * from base x
    where (p_send is null
        or (p_send = 'sending' and x.send_state in ('queued', 'in_instantly', 'replied'))
        or (p_send = 'pulled' and x.send_state = 'pulled'))
      and (p_pattern is null
        or x.email ilike p_pattern
        or (
          x.row_data::text ilike p_pattern
          and exists (
            select 1 from jsonb_each_text(case when jsonb_typeof(x.row_data) = 'object' then x.row_data else '{}'::jsonb end) e
            where e.value ilike p_pattern
          )
        ))
  )
  select jsonb_build_object(
    'total', (select count(*) from m),
    'send_counts', (select jsonb_build_object(
        'sending', count(*) filter (where send_state in ('queued', 'in_instantly', 'replied')),
        'pulled', count(*) filter (where send_state = 'pulled'),
        'banked', count(*) filter (where send_state <> 'not_sent'),
        'all', count(*)
      ) from base),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.row_index, x.id)
      from (select * from m order by row_index, id offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 100), 1), 1000)) x
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.lume_validation_rows_page(uuid, text, text, text, int, int) from public, anon, authenticated;
grant execute on function public.lume_validation_rows_page(uuid, text, text, text, int, int) to service_role;
