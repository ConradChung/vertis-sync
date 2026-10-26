-- Lume CRM (part 4): crm_set_stage(), follow-ups view + tick + pg_cron,
-- lume_overview() + crm_followups_due, crm_backfill(dry_run).

-- Atomic stage change. Returns the previous stage, or null when the deal does
-- not exist. Same stage → no activity. A reason is stored for Won/Lost.
create or replace function public.crm_set_stage(
  p_deal_id uuid, p_stage text, p_source text, p_reason text default null, p_payload jsonb default '{}'::jsonb
) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_old text;
  v_campaign text;
begin
  select stage, campaign_id into v_old, v_campaign from crm_deals where id = p_deal_id for update;
  if not found then return null; end if;
  if not exists (
    select 1 from crm_stages s
    where s.name = p_stage
      and s.campaign_id = case when exists (select 1 from crm_stages where campaign_id = v_campaign) then v_campaign else '_default' end
  ) then
    raise exception 'unknown stage %', p_stage using errcode = '22023';
  end if;
  if v_old = p_stage then return v_old; end if;
  update crm_deals set stage = p_stage,
         won_lost_reason = case when p_stage in ('Won','Lost') then nullif(trim(p_reason), '') else won_lost_reason end,
         last_activity_at = now(), updated_at = now()
   where id = p_deal_id;
  insert into crm_activities (deal_id, kind, payload, source)
  values (p_deal_id, 'stage_changed',
          coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('from', v_old, 'to', p_stage)
            || case when nullif(trim(p_reason), '') is null then '{}'::jsonb else jsonb_build_object('reason', trim(p_reason)) end,
          p_source);
  return v_old;
end $$;
revoke all on function public.crm_set_stage(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.crm_set_stage(uuid, text, text, text, jsonb) to service_role;

-- Follow-ups due: next_action_at passed, deal still open.
create or replace view public.lume_crm_followups as
  select d.id, d.campaign_id, d.email, d.name, d.company, d.stage, d.owner,
         d.next_action, d.next_action_at, d.last_activity_at, d.followup_flagged_at
  from public.crm_deals d
  where d.next_action_at is not null
    and d.next_action_at <= now()
    and d.stage not in ('Won','Lost','Bounced');
revoke all on public.lume_crm_followups from public, anon, authenticated, service_role;
grant select on public.lume_crm_followups to service_role;

-- Flags deals that became due since the last tick: one `lume.crm_followup_due`
-- event each (Overview agent feed + Realtime). Returns how many it flagged.
create or replace function public.crm_followup_tick() returns int
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_n int;
begin
  with due as (
    update crm_deals d set followup_flagged_at = now()
     where d.id in (select f.id from lume_crm_followups f
                     where f.followup_flagged_at is null or f.followup_flagged_at < f.next_action_at)
    returning d.id, d.campaign_id, d.email, d.name, d.next_action, d.next_action_at
  ), ins as (
    insert into events (type, source, source_id, campaign_id, lead_email, title, payload)
    select 'lume.crm_followup_due', 'lume', due.id::text, due.campaign_id, due.email,
           format('Follow-up due: %s', coalesce(nullif(due.name, ''), due.email)),
           jsonb_build_object('deal_id', due.id, 'next_action', due.next_action, 'next_action_at', due.next_action_at)
    from due
    returning 1
  )
  select count(*) into v_n from ins;
  return v_n;
end $$;
revoke all on function public.crm_followup_tick() from public, anon, authenticated;
grant execute on function public.crm_followup_tick() to service_role;

-- cron.schedule with an existing jobname updates that job (pg_cron >= 1.3).
select cron.schedule('crm-followup-tick', '*/15 * * * *', 'select public.crm_followup_tick()');

-- Overview: + crm_followups_due (shown in the Pending approvals tile).
create or replace function public.lume_overview() returns json
language sql stable security definer set search_path = pg_catalog, public as $$
  select json_build_object(
    'now', now(),
    'pending_gates', (select count(*) from lume_gates),
    'replies_today', (select count(*) from events where type = 'reply'
                        and created_at > (date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles')),
    'bounces_24h', (select count(*) from events where type = 'bounce' and created_at > now() - interval '24 hours'),
    'active_jobs', (select count(*) from validation_jobs where status in ('pending','processing')),
    'lead_bank_queued', (select count(*) from lead_bank where state = 'queued'),
    'crm_followups_due', (select count(*) from lume_crm_followups),
    -- canary: should move whenever a watched column changes anywhere
    'events_last_at', (select max(created_at) from events),
    'recent_events', (select coalesce(json_agg(e order by e.created_at desc), '[]'::json)
                      from (select * from events order by created_at desc limit 50) e)
  );
$$;
revoke all on function public.lume_overview() from public, anon, authenticated;
grant execute on function public.lume_overview() to service_role;

-- Backfill (owner-approved run only). "Sent" = a lead_bank row Instantly has
-- had: state active/completed/replied/bounced/unsubscribed, or skipped
-- (orphaned after being pushed) with pushed_at set. Queued rows are not sent.
-- Stage: bounced → Bounced; Instantly interest_status '1' → Interested;
-- replied state or email_reply_count > 0 → Replied; else Contacted. Existing
-- deals are kept (on conflict do nothing). dry_run = true only counts.
create or replace function public.crm_backfill(dry_run boolean default true)
returns table (stage text, deals bigint)
language plpgsql security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
begin
  create temp table if not exists _crm_backfill_src (
    lead_id bigint, campaign_id text, email text, name text, company text, city text,
    stage text, last_at timestamptz
  ) on commit drop;
  truncate _crm_backfill_src;
  insert into _crm_backfill_src
  select distinct on (l.campaign_id, lower(trim(l.email)))
         l.id, l.campaign_id, lower(trim(l.email)),
         nullif(trim(concat_ws(' ', l.first_name, l.last_name)), ''),
         l.company_name, l.location,
         case when l.state = 'bounced' then 'Bounced'
              when l.interest_status = '1' then 'Interested'
              when l.state = 'replied' or coalesce(l.email_reply_count, 0) > 0 then 'Replied'
              else 'Contacted' end,
         coalesce(l.finished_at, l.pushed_at, l.updated_at)
    from lead_bank l
   where l.email is not null and trim(l.email) <> '' and l.campaign_id is not null
     and (l.state in ('active','completed','replied','bounced','unsubscribed')
          or (l.state = 'skipped' and l.pushed_at is not null))
   order by l.campaign_id, lower(trim(l.email)), l.id desc;

  if not dry_run then
    with ins as (
      insert into crm_deals (campaign_id, lead_id, email, name, company, city, source, stage, last_activity_at)
      select s.campaign_id, s.lead_id, s.email, s.name, s.company, s.city, 'instantly', s.stage, s.last_at
        from _crm_backfill_src s
      on conflict (campaign_id, email) do nothing
      returning id, stage, last_activity_at
    )
    insert into crm_activities (deal_id, kind, payload, occurred_at, source, dedupe_key)
    select ins.id, 'stage_changed', jsonb_build_object('from', null, 'to', ins.stage, 'backfill', true),
           coalesce(ins.last_activity_at, now()), 'agent', 'backfill:' || ins.id
      from ins;
  end if;

  return query
    select s.stage, count(*)::bigint from _crm_backfill_src s
     group by s.stage
     order by min(case s.stage when 'Contacted' then 0 when 'Replied' then 1 when 'Interested' then 2 else 3 end);
end $$;
revoke all on function public.crm_backfill(boolean) from public, anon, authenticated;
grant execute on function public.crm_backfill(boolean) to service_role;
