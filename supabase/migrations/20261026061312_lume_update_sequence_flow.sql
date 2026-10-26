-- Lume campaigns: pending_actions.kind += update_sequence (editing a live
-- campaign's email copy goes through the Approve/Deny gate; one awaiting edit
-- per campaign), and lume_campaign_lead_sources(campaign) for the Flow tab:
-- lead_bank counts by state, the rotation_runs log and the instantly-rotate
-- pg_cron schedules (cron.* is not reachable through PostgREST).
alter table public.pending_actions drop constraint if exists pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly','launch_campaign','assign_leads','activate_rule','send_reply','pause_campaign',
  'resume_campaign','create_campaign','decide_gate','delete_rule','crm_close_deal','run_actor',
  'update_sequence']));
create unique index if not exists pending_actions_one_awaiting_sequence_idx
  on public.pending_actions (kind, (payload->>'campaign_id'))
  where status = 'awaiting' and kind = 'update_sequence';

create or replace function public.lume_campaign_lead_sources(p_campaign text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'bank', coalesce((
      select jsonb_object_agg(state, n) from (
        select coalesce(state, 'unknown') as state, count(*) as n
        from public.lead_bank where campaign_id = p_campaign group by 1
      ) s), '{}'::jsonb),
    'runs', (
      select jsonb_build_object(
        'count', count(*),
        'pushed', coalesce(sum(pushed), 0),
        'first_at', min(ran_at),
        'last', (select jsonb_build_object('ran_at', r.ran_at, 'pushed', r.pushed, 'deleted', r.deleted,
                   'archived', r.archived, 'in_instantly_after', r.in_instantly_after, 'note', r.note,
                   'errors', coalesce(jsonb_array_length(case when jsonb_typeof(r.errors) = 'array' then r.errors end), 0))
                 from public.rotation_runs r where r.campaign_id = p_campaign order by r.ran_at desc limit 1)
      ) from public.rotation_runs where campaign_id = p_campaign),
    'crons', case when exists (select 1 from public.rotation_runs where campaign_id = p_campaign) then coalesce((
      select jsonb_agg(jsonb_build_object('name', jobname, 'schedule', schedule, 'active', active) order by jobname)
      from cron.job where jobname like 'instantly-rotate%'), '[]'::jsonb) else '[]'::jsonb end
  );
$$;
revoke all on function public.lume_campaign_lead_sources(text) from public, anon, authenticated;
grant execute on function public.lume_campaign_lead_sources(text) to service_role;
