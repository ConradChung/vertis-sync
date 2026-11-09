-- Lead bank routing for big pushes + multi-campaign rotation (additive only).
--
-- instantly-push: a push whose eligible leads exceed lume_settings.bank_threshold (default 1000)
-- queues them in lead_bank (state 'queued') instead of creating them in Instantly; instantly-rotate
-- then drips every campaign with queued leads into the shared workspace cap, oldest queued first.

-- 1. Job: which route the push took (decided once, kept across self re-invokes) and how many were banked.
alter table public.validation_jobs
  add column if not exists instantly_banked integer not null default 0,
  add column if not exists instantly_route text,
  add column if not exists instantly_bank_threshold integer;
alter table public.validation_jobs drop constraint if exists validation_jobs_instantly_route_check;
alter table public.validation_jobs add constraint validation_jobs_instantly_route_check
  check (instantly_route is null or instantly_route in ('direct', 'bank'));
comment on column public.validation_jobs.instantly_banked is 'Leads this push queued in lead_bank (route = bank) instead of creating in Instantly.';
comment on column public.validation_jobs.instantly_route is 'instantly-push route: direct (created in Instantly) or bank (queued in lead_bank for instantly-rotate). Null until the push starts.';
comment on column public.validation_jobs.instantly_bank_threshold is 'The bank_threshold the push compared its eligible count against.';

-- 2. Row: 'banked' = queued in lead_bank by instantly-push (a superset of the old check).
alter table public.validation_rows drop constraint if exists validation_rows_instantly_status_check;
alter table public.validation_rows add constraint validation_rows_instantly_status_check
  check (instantly_status = any (array['skipped', 'pushed', 'filtered', 'error', 'banked']));

-- 3. Bank row: which validation job queued it (traceability; null for older rows and Lume assigns).
alter table public.lead_bank
  add column if not exists source_job_id uuid references public.validation_jobs(id) on delete set null;
create index if not exists lead_bank_source_job_idx on public.lead_bank (source_job_id) where source_job_id is not null;
comment on column public.lead_bank.source_job_id is 'validation_jobs.id of the instantly-push that banked this lead (route = bank).';

-- 4. Rotation run: one row per run; campaign_id stays ROTATE_CAMPAIGN_ID, the breakdown lives here.
alter table public.rotation_runs
  add column if not exists campaign_ids text[],
  add column if not exists per_campaign jsonb;
comment on column public.rotation_runs.campaign_ids is 'Every campaign the run served (ROTATE_CAMPAIGN_ID always first).';
comment on column public.rotation_runs.per_campaign is '{campaign_id: {archived, deleted, pushed, orphaned, in_instantly}} for this run.';

-- 5. Threshold setting (Lume Settings -> Budget), integer 1..100000, seeded at 1000.
alter table public.lume_settings drop constraint if exists lume_settings_bank_threshold_check;
alter table public.lume_settings add constraint lume_settings_bank_threshold_check check (
  key <> 'bank_threshold' or (
    jsonb_typeof(value) = 'number'
    and (value #>> '{}')::numeric >= 1
    and (value #>> '{}')::numeric <= 100000
    and (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
  )
);
insert into public.lume_settings (key, value) values ('bank_threshold', '1000'::jsonb) on conflict (key) do nothing;

-- 6. Campaigns the rotation serves: any with queued / active / replied bank rows.
create or replace function public.lead_bank_rotation_campaigns()
returns setof text
language sql
stable
set search_path = public, pg_catalog
as $$
  select distinct campaign_id from public.lead_bank where state in ('queued', 'active', 'replied') order by 1;
$$;
revoke all on function public.lead_bank_rotation_campaigns() from public, anon, authenticated;
grant execute on function public.lead_bank_rotation_campaigns() to service_role;

-- 7. Lume's per-campaign rotation summary: also count runs that served the campaign as a non-primary
--    one, with that campaign's own pushed / deleted / archived. Same output shape; identical for
--    single-campaign runs (campaign_id = p_campaign, per_campaign absent or holding the same numbers).
create or replace function public.lume_campaign_lead_sources(p_campaign text)
returns jsonb
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  with r as (
    select ran_at, note, errors, in_instantly_after,
           coalesce((per_campaign -> p_campaign ->> 'pushed')::int, case when campaign_id = p_campaign then pushed end) as pushed,
           coalesce((per_campaign -> p_campaign ->> 'deleted')::int, case when campaign_id = p_campaign then deleted end) as deleted,
           coalesce((per_campaign -> p_campaign ->> 'archived')::int, case when campaign_id = p_campaign then archived end) as archived
      from public.rotation_runs
     where campaign_id = p_campaign or p_campaign = any (campaign_ids)
  )
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
        'last', (select jsonb_build_object('ran_at', x.ran_at, 'pushed', x.pushed, 'deleted', x.deleted,
                   'archived', x.archived, 'in_instantly_after', x.in_instantly_after, 'note', x.note,
                   'errors', coalesce(jsonb_array_length(case when jsonb_typeof(x.errors) = 'array' then x.errors end), 0))
                 from r x order by x.ran_at desc limit 1)
      ) from r),
    'crons', case when exists (select 1 from r) then coalesce((
      select jsonb_agg(jsonb_build_object('name', jobname, 'schedule', schedule, 'active', active) order by jobname)
      from cron.job where jobname like 'instantly-rotate%'), '[]'::jsonb) else '[]'::jsonb end
  );
$function$;
