-- Rotate → Pushes: say WHY leads were stopped. Each stopped (never pushed)
-- lead keeps a short reason and when it was stopped; the pushes view returns
-- the reasons per push x campaign so the owner can see at a glance.

alter table public.lead_bank add column if not exists stop_reason text;
alter table public.lead_bank add column if not exists stopped_at timestamptz;

-- Backfill: the Nov 11 company screen on Kaspen Main (icp_status = not_icp).
update public.lead_bank b
set stop_reason = 'Not a property manager (company research)', stopped_at = b.updated_at
from public.validation_rows r
where b.state = 'skipped' and b.pushed_at is null and b.stop_reason is null
  and r.job_id = b.source_job_id and lower(trim(r.email)) = b.email and r.status = 'valid'
  and r.row_data ->> 'icp_status' = 'not_icp';

drop function if exists public.lume_lead_bank_pushes();
create function public.lume_lead_bank_pushes()
returns table (
  source_job_id uuid, job_name text, filename text, campaign_id text,
  queued bigint, stopped bigint, active bigint, finished bigint,
  first_banked_at timestamptz, last_pushed_at timestamptz,
  stop_reasons jsonb
)
language sql stable security definer
set search_path to 'public'
as $$
  with base as (
    select b.source_job_id,
           coalesce(nullif(trim(j.display_name), ''), j.filename) as job_name,
           j.filename,
           b.campaign_id::text as campaign_id,
           count(*) filter (where b.state = 'queued') as queued,
           count(*) filter (where b.state = 'skipped' and b.pushed_at is null) as stopped,
           count(*) filter (where b.state in ('active', 'replied')) as active,
           count(*) filter (where b.state in ('completed', 'bounced', 'unsubscribed') or (b.state = 'skipped' and b.pushed_at is not null)) as finished,
           min(b.created_at) as first_banked_at,
           max(b.pushed_at) as last_pushed_at
    from public.lead_bank b
    left join public.validation_jobs j on j.id = b.source_job_id
    group by b.source_job_id, j.display_name, j.filename, b.campaign_id
  ),
  reasons as (
    select r.source_job_id, r.campaign_id,
           jsonb_agg(jsonb_build_object('reason', r.reason, 'count', r.n, 'at', r.at) order by r.n desc) as stop_reasons
    from (
      select b.source_job_id, b.campaign_id::text as campaign_id,
             coalesce(b.stop_reason, 'No reason recorded') as reason,
             count(*) as n, max(b.stopped_at) as at
      from public.lead_bank b
      where b.state = 'skipped' and b.pushed_at is null
      group by 1, 2, 3
    ) r
    group by r.source_job_id, r.campaign_id
  )
  select base.*, coalesce(reasons.stop_reasons, '[]'::jsonb)
  from base
  left join reasons on reasons.source_job_id is not distinct from base.source_job_id and reasons.campaign_id = base.campaign_id
$$;

-- stop now records a reason (p_reason; blank = 'Stopped by hand'); restart clears it.
drop function if exists public.lume_lead_bank_queue_op(uuid, text, text, text);
create function public.lume_lead_bank_queue_op(p_job uuid, p_campaign text, p_op text, p_to text default null, p_reason text default null)
returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare
  n int := 0;
  kept int := 0;
begin
  if p_op = 'stop' then
    update public.lead_bank b
    set state = 'skipped', updated_at = now(), stopped_at = now(),
        stop_reason = coalesce(nullif(left(trim(p_reason), 200), ''), 'Stopped by hand')
    where b.campaign_id = p_campaign and b.source_job_id is not distinct from p_job
      and b.state = 'queued' and b.pushed_at is null;
    get diagnostics n = row_count;
  elsif p_op = 'restart' then
    update public.lead_bank b set state = 'queued', updated_at = now(), stop_reason = null, stopped_at = null
    where b.campaign_id = p_campaign and b.source_job_id is not distinct from p_job
      and b.state = 'skipped' and b.pushed_at is null;
    get diagnostics n = row_count;
  elsif p_op = 'move' then
    if p_to is null or p_to = p_campaign then
      raise exception 'move needs a different target campaign';
    end if;
    update public.lead_bank b set campaign_id = p_to, updated_at = now()
    where b.campaign_id = p_campaign and b.source_job_id is not distinct from p_job
      and b.state = 'queued' and b.pushed_at is null
      and not exists (select 1 from public.lead_bank o where o.campaign_id = p_to and o.email = b.email);
    get diagnostics n = row_count;
    select count(*) into kept from public.lead_bank b
    where b.campaign_id = p_campaign and b.source_job_id is not distinct from p_job
      and b.state = 'queued' and b.pushed_at is null;
  else
    raise exception 'unknown op %', p_op;
  end if;
  return jsonb_build_object('changed', n, 'kept', kept);
end;
$$;

revoke all on function public.lume_lead_bank_pushes() from public, anon, authenticated;
grant execute on function public.lume_lead_bank_pushes() to service_role;
revoke all on function public.lume_lead_bank_queue_op(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.lume_lead_bank_queue_op(uuid, text, text, text, text) to service_role;
