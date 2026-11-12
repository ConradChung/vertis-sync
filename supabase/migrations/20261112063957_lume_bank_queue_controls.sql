-- Rotate → Pushes: each push's lead bank queue (per source job x campaign),
-- and the bank_queue action that stops, restarts or moves it after Confirm.
-- Only rows never pushed to Instantly change; active / finished rows stay.

alter table public.pending_actions drop constraint pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly', 'launch_campaign', 'assign_leads', 'activate_rule', 'send_reply', 'pause_campaign', 'resume_campaign',
  'create_campaign', 'decide_gate', 'delete_rule', 'crm_close_deal', 'run_actor', 'update_sequence', 'issue_operator_key',
  'remove_leads', 'label_reply', 'influencer_run', 'influencer_reactions', 'stage_attachment', 'influencer_lookup',
  'influencer_approve', 'send_lead_list', 'delete_lead_list', 'remove_lead_rows', 'new_campaign', 'company_check',
  'bank_queue'
]::text[]));

create unique index if not exists pending_actions_one_awaiting_bank_queue_idx
  on public.pending_actions (kind, (payload ->> 'push_key'))
  where status = 'awaiting' and kind = 'bank_queue';

-- One row per (source job, campaign): queued, stopped (skipped before ever
-- being pushed), in Instantly, finished. Jobs with no source are one group.
create or replace function public.lume_lead_bank_pushes()
returns table (
  source_job_id uuid, job_name text, filename text, campaign_id text,
  queued bigint, stopped bigint, active bigint, finished bigint,
  first_banked_at timestamptz, last_pushed_at timestamptz
)
language sql stable security definer
set search_path to 'public'
as $$
  select b.source_job_id,
         coalesce(nullif(trim(j.display_name), ''), j.filename),
         j.filename,
         b.campaign_id::text,
         count(*) filter (where b.state = 'queued'),
         count(*) filter (where b.state = 'skipped' and b.pushed_at is null),
         count(*) filter (where b.state in ('active', 'replied')),
         count(*) filter (where b.state in ('completed', 'bounced', 'unsubscribed') or (b.state = 'skipped' and b.pushed_at is not null)),
         min(b.created_at),
         max(b.pushed_at)
  from public.lead_bank b
  left join public.validation_jobs j on j.id = b.source_job_id
  group by b.source_job_id, j.display_name, j.filename, b.campaign_id
$$;

-- stop: queued → skipped · restart: stopped → queued · move: queued → p_to
-- (emails already in p_to stay where they are). p_job null = rows with no
-- source job. Returns { changed, kept }.
create or replace function public.lume_lead_bank_queue_op(p_job uuid, p_campaign text, p_op text, p_to text default null)
returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare
  n int := 0;
  kept int := 0;
begin
  if p_op = 'stop' then
    update public.lead_bank b set state = 'skipped', updated_at = now()
    where b.campaign_id = p_campaign and b.source_job_id is not distinct from p_job
      and b.state = 'queued' and b.pushed_at is null;
    get diagnostics n = row_count;
  elsif p_op = 'restart' then
    update public.lead_bank b set state = 'queued', updated_at = now()
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
revoke all on function public.lume_lead_bank_queue_op(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.lume_lead_bank_queue_op(uuid, text, text, text) to service_role;
