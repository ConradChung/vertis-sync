-- Tags: pipeline items carry the owner's line of business (lume_verticals) so
-- Progress, the lead lists and the agent can keep Kaspen's to-dos apart from
-- the recruiting job pulls. The "tag" is the vertical; there is no second
-- concept. Additive: nullable columns, triggers that only fill a null (or a
-- value that was inherited from the parent being retagged), a view that gains
-- two trailing columns. Edge functions are untouched: every rule is a trigger.
--
-- Rules (lume/lib/tags/rules.ts mirrors them for tests):
--  job_batches       always the 'jobs' vertical when inserted untagged.
--  apollo_orders     the job batch with the same Leadsfriday order, if any.
--  telegram_ingests  the lead list sent as it (sent_ingest_id) or the Apollo
--                    order that delivered it (ingest_id), when those are set.
--  validation_jobs   the ingest it came from (telegram_ingests.validation_job_id);
--                    else source 'hnwi' → 'hnwi'; else the vertical owning its
--                    Instantly campaign.
--  lead_review_sets  its project's vertical; else influencer sheets → 'pm_reactions';
--                    else the vertical of the chat that made it.
--  pending_actions   the item its payload names (job_id / target_id / list_id),
--                    payload.vertical_id, the vertical owning payload.campaign_id,
--                    else the chat whose run requested it.
--  lume_tasks        its chat's vertical, else its filed action's.
-- A child that inherited its tag follows a retag of the parent; a child the
-- owner tagged differently keeps its own. Tagging never bumps updated_at.

-- 1. Stable handles for the rules (names can be renamed in Settings).
alter table public.lume_verticals add column if not exists key text;
create unique index if not exists lume_verticals_key_idx on public.lume_verticals (key) where key is not null;
comment on column public.lume_verticals.key is 'Stable handle used by the auto-tag triggers: jobs, hnwi, pm_reactions.';
update public.lume_verticals set key = 'jobs' where key is null and name = 'Job search / GTM roles';
update public.lume_verticals set key = 'hnwi' where key is null and name = 'HNWI / wealth management';
update public.lume_verticals set key = 'pm_reactions' where key is null and name = 'PM reactions';

-- 2. The tag columns.
alter table public.job_batches      add column if not exists vertical_id uuid references public.lume_verticals(id) on delete set null;
alter table public.telegram_ingests add column if not exists vertical_id uuid references public.lume_verticals(id) on delete set null;
alter table public.validation_jobs  add column if not exists vertical_id uuid references public.lume_verticals(id) on delete set null;
alter table public.lead_review_sets add column if not exists vertical_id uuid references public.lume_verticals(id) on delete set null;
alter table public.apollo_orders    add column if not exists vertical_id uuid references public.lume_verticals(id) on delete set null;
alter table public.lume_tasks       add column if not exists vertical_id uuid references public.lume_verticals(id) on delete set null;
alter table public.pending_actions  add column if not exists vertical_id uuid references public.lume_verticals(id) on delete set null;

create index if not exists job_batches_vertical_idx      on public.job_batches (vertical_id) where vertical_id is not null;
create index if not exists telegram_ingests_vertical_idx on public.telegram_ingests (vertical_id) where vertical_id is not null;
create index if not exists validation_jobs_vertical_idx  on public.validation_jobs (vertical_id) where vertical_id is not null;
create index if not exists lead_review_sets_vertical_idx on public.lead_review_sets (vertical_id) where vertical_id is not null;
create index if not exists apollo_orders_vertical_idx    on public.apollo_orders (vertical_id) where vertical_id is not null;
create index if not exists lume_tasks_vertical_idx       on public.lume_tasks (vertical_id) where vertical_id is not null;
create index if not exists pending_actions_vertical_idx  on public.pending_actions (vertical_id) where vertical_id is not null;
-- Link columns the rules look up by.
create index if not exists telegram_ingests_validation_job_idx on public.telegram_ingests (validation_job_id) where validation_job_id is not null;
create index if not exists agent_messages_run_idx on public.agent_messages (run_id) where run_id is not null;
create index if not exists lume_tasks_action_idx on public.lume_tasks (action_id) where action_id is not null;

-- 3. Lookups.
create or replace function public.lume_vertical_by_key(k text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from lume_verticals where key = k and archived_at is null limit 1
$$;

create or replace function public.lume_conversation_vertical(conv uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(c.vertical_id, p.vertical_id)
  from agent_conversations c left join agent_projects p on p.id = c.project_id
  where c.id = conv
$$;

-- The live vertical whose campaign_ids holds this campaign (first by name, as lib/operators/route.ts verticalFor).
create or replace function public.lume_campaign_vertical(campaign text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from lume_verticals
  where archived_at is null and nullif(btrim(campaign), '') is not null and btrim(campaign) = any (campaign_ids)
  order by name, id limit 1
$$;

-- Any taggable row's tag, by id (text so payload values can be passed straight in).
create or replace function public.lume_item_vertical(item text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  u uuid;
  v uuid;
begin
  if item is null or item !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  u := item::uuid;
  select vertical_id into v from validation_jobs where id = u;  if v is not null then return v; end if;
  select vertical_id into v from telegram_ingests where id = u; if v is not null then return v; end if;
  select vertical_id into v from job_batches where id = u;      if v is not null then return v; end if;
  select vertical_id into v from apollo_orders where id = u;    if v is not null then return v; end if;
  select vertical_id into v from lead_review_sets where id = u; if v is not null then return v; end if;
  return null;
end
$$;

create or replace function public.lume_action_vertical(payload jsonb, run uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    public.lume_item_vertical(payload ->> 'job_id'),
    public.lume_item_vertical(payload ->> 'target_id'),
    public.lume_item_vertical(payload ->> 'list_id'),
    (select id from lume_verticals where id::text = payload ->> 'vertical_id' and archived_at is null),
    public.lume_campaign_vertical(payload ->> 'campaign_id'),
    public.lume_campaign_vertical(payload ->> 'source_campaign_id'),
    (select public.lume_conversation_vertical(m.conversation_id)
       from agent_messages m where run is not null and m.run_id = run
       order by m.created_at limit 1)
  )
$$;

revoke all on function public.lume_vertical_by_key(text), public.lume_conversation_vertical(uuid), public.lume_campaign_vertical(text),
  public.lume_item_vertical(text), public.lume_action_vertical(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.lume_conversation_vertical(uuid) to service_role;

-- 4. Fill-on-write triggers (BEFORE: set the row's own tag when it is null).
create or replace function public.lume_tag_job_batch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.vertical_id is null then new.vertical_id := public.lume_vertical_by_key('jobs'); end if;
  return new;
end
$$;
drop trigger if exists lume_tag_job_batches on public.job_batches;
create trigger lume_tag_job_batches before insert on public.job_batches
  for each row execute function public.lume_tag_job_batch();

create or replace function public.lume_tag_apollo_order() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.vertical_id is null and new.leadsfriday_order_id is not null then
    select b.vertical_id into new.vertical_id from job_batches b
    where b.leadsfriday_order_id = new.leadsfriday_order_id and b.vertical_id is not null
    order by b.created_at desc limit 1;
  end if;
  return new;
end
$$;
drop trigger if exists lume_tag_apollo_orders on public.apollo_orders;
create trigger lume_tag_apollo_orders before insert or update of leadsfriday_order_id on public.apollo_orders
  for each row execute function public.lume_tag_apollo_order();

create or replace function public.lume_tag_validation_job() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.vertical_id is null then
    select i.vertical_id into new.vertical_id from telegram_ingests i
    where i.validation_job_id = new.id and i.vertical_id is not null limit 1;
  end if;
  if new.vertical_id is null and new.source = 'hnwi' then
    new.vertical_id := public.lume_vertical_by_key('hnwi');
  end if;
  if new.vertical_id is null then
    new.vertical_id := coalesce(public.lume_campaign_vertical(new.instantly_campaign_id), public.lume_campaign_vertical(new.instantly_campaign_id_nolocation));
  end if;
  return new;
end
$$;
drop trigger if exists lume_tag_validation_jobs on public.validation_jobs;
create trigger lume_tag_validation_jobs before insert or update of instantly_campaign_id, instantly_campaign_id_nolocation, source on public.validation_jobs
  for each row execute function public.lume_tag_validation_job();

-- A list: its project's vertical; a list that inherited the old project's tag follows a move.
create or replace function public.lume_tag_lead_set() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  old_project_vertical uuid;
begin
  if tg_op = 'UPDATE' then
    if new.vertical_id is distinct from old.vertical_id then return new; end if;  -- an explicit tag wins
    if new.project_id is not distinct from old.project_id then return new; end if;
    select vertical_id into old_project_vertical from agent_projects where id = old.project_id;
    if new.vertical_id is not null and new.vertical_id is distinct from old_project_vertical then return new; end if;
    new.vertical_id := null;
  end if;
  if new.vertical_id is null and new.project_id is not null then
    select vertical_id into new.vertical_id from agent_projects where id = new.project_id;
  end if;
  if new.vertical_id is null and new.sheet_kind = 'influencer_candidates' then
    new.vertical_id := public.lume_vertical_by_key('pm_reactions');
  end if;
  if new.vertical_id is null and new.source_conversation_id is not null then
    new.vertical_id := public.lume_conversation_vertical(new.source_conversation_id);
  end if;
  return new;
end
$$;
drop trigger if exists lume_tag_lead_review_sets on public.lead_review_sets;
create trigger lume_tag_lead_review_sets before insert or update of project_id on public.lead_review_sets
  for each row execute function public.lume_tag_lead_set();

create or replace function public.lume_tag_pending_action() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.vertical_id is null then new.vertical_id := public.lume_action_vertical(new.payload, new.agent_run_id); end if;
  return new;
end
$$;
drop trigger if exists lume_tag_pending_actions on public.pending_actions;
create trigger lume_tag_pending_actions before insert on public.pending_actions
  for each row execute function public.lume_tag_pending_action();

create or replace function public.lume_tag_task() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.vertical_id is null and new.conversation_id is not null then
    new.vertical_id := public.lume_conversation_vertical(new.conversation_id);
  end if;
  if new.vertical_id is null and new.action_id is not null then
    select vertical_id into new.vertical_id from pending_actions where id = new.action_id;
  end if;
  return new;
end
$$;
drop trigger if exists lume_tag_lume_tasks on public.lume_tasks;
create trigger lume_tag_lume_tasks before insert or update of conversation_id, action_id on public.lume_tasks
  for each row execute function public.lume_tag_task();

-- 5. Carry-down triggers (AFTER: a parent's tag reaches the child that has none,
--    or that still holds what it inherited from the parent).
create or replace function public.lume_tag_carry_project() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update lead_review_sets s set vertical_id = new.vertical_id
  where s.project_id = new.id and s.vertical_id is distinct from new.vertical_id
    and (s.vertical_id is null or s.vertical_id is not distinct from old.vertical_id)
    and new.vertical_id is not null;
  return null;
end
$$;
drop trigger if exists lume_tag_carry_agent_projects on public.agent_projects;
create trigger lume_tag_carry_agent_projects after update of vertical_id on public.agent_projects
  for each row when (old.vertical_id is distinct from new.vertical_id) execute function public.lume_tag_carry_project();

create or replace function public.lume_tag_carry_lead_set() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.sent_ingest_id is null then return null; end if;
  update telegram_ingests i set vertical_id = new.vertical_id
  where i.id = new.sent_ingest_id and i.vertical_id is distinct from new.vertical_id
    and (i.vertical_id is null or (tg_op = 'UPDATE' and i.vertical_id is not distinct from old.vertical_id));
  return null;
end
$$;
drop trigger if exists lume_tag_carry_lead_review_sets on public.lead_review_sets;
create trigger lume_tag_carry_lead_review_sets after insert or update of vertical_id, sent_ingest_id on public.lead_review_sets
  for each row execute function public.lume_tag_carry_lead_set();

create or replace function public.lume_tag_carry_apollo_order() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.ingest_id is null then return null; end if;
  update telegram_ingests i set vertical_id = new.vertical_id
  where i.id = new.ingest_id and i.vertical_id is distinct from new.vertical_id
    and (i.vertical_id is null or (tg_op = 'UPDATE' and i.vertical_id is not distinct from old.vertical_id));
  return null;
end
$$;
drop trigger if exists lume_tag_carry_apollo_orders on public.apollo_orders;
create trigger lume_tag_carry_apollo_orders after insert or update of vertical_id, ingest_id on public.apollo_orders
  for each row execute function public.lume_tag_carry_apollo_order();

create or replace function public.lume_tag_carry_ingest() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.validation_job_id is null then return null; end if;
  update validation_jobs j set vertical_id = new.vertical_id
  where j.id = new.validation_job_id and j.vertical_id is distinct from new.vertical_id
    and (j.vertical_id is null or (tg_op = 'UPDATE' and j.vertical_id is not distinct from old.vertical_id));
  return null;
end
$$;
drop trigger if exists lume_tag_carry_telegram_ingests on public.telegram_ingests;
create trigger lume_tag_carry_telegram_ingests after insert or update of vertical_id, validation_job_id on public.telegram_ingests
  for each row execute function public.lume_tag_carry_ingest();

create or replace function public.lume_tag_carry_action() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update lume_tasks t set vertical_id = new.vertical_id
  where t.action_id = new.id and t.vertical_id is distinct from new.vertical_id
    and (t.vertical_id is null or t.vertical_id is not distinct from old.vertical_id);
  return null;
end
$$;
drop trigger if exists lume_tag_carry_pending_actions on public.pending_actions;
create trigger lume_tag_carry_pending_actions after update of vertical_id on public.pending_actions
  for each row when (old.vertical_id is distinct from new.vertical_id) execute function public.lume_tag_carry_action();

-- 6. A tag-only update keeps updated_at (Progress "recent" and gate ages read it).
--    Named zz_ so it fires after the set_*_updated_at BEFORE triggers.
create or replace function public.lume_tag_keep_updated_at() returns trigger
language plpgsql as $$
begin
  if (to_jsonb(new) - 'vertical_id' - 'updated_at') = (to_jsonb(old) - 'vertical_id' - 'updated_at') then
    new.updated_at := old.updated_at;
  end if;
  return new;
end
$$;
drop trigger if exists zz_lume_tag_keep_updated_at on public.validation_jobs;
create trigger zz_lume_tag_keep_updated_at before update of vertical_id on public.validation_jobs
  for each row when (old.vertical_id is distinct from new.vertical_id) execute function public.lume_tag_keep_updated_at();
drop trigger if exists zz_lume_tag_keep_updated_at on public.job_batches;
create trigger zz_lume_tag_keep_updated_at before update of vertical_id on public.job_batches
  for each row when (old.vertical_id is distinct from new.vertical_id) execute function public.lume_tag_keep_updated_at();
drop trigger if exists zz_lume_tag_keep_updated_at on public.apollo_orders;
create trigger zz_lume_tag_keep_updated_at before update of vertical_id on public.apollo_orders
  for each row when (old.vertical_id is distinct from new.vertical_id) execute function public.lume_tag_keep_updated_at();
drop trigger if exists zz_lume_tag_keep_updated_at on public.pending_actions;
create trigger zz_lume_tag_keep_updated_at before update of vertical_id on public.pending_actions
  for each row when (old.vertical_id is distinct from new.vertical_id) execute function public.lume_tag_keep_updated_at();

-- 7. Backfill, parents first (the carry-down triggers fill the children as it goes).
update public.job_batches set vertical_id = public.lume_vertical_by_key('jobs') where vertical_id is null;
update public.apollo_orders o set vertical_id = b.vertical_id
  from public.job_batches b
  where o.vertical_id is null and o.leadsfriday_order_id is not null and b.leadsfriday_order_id = o.leadsfriday_order_id and b.vertical_id is not null;
update public.lead_review_sets s set vertical_id = coalesce(
    (select p.vertical_id from public.agent_projects p where p.id = s.project_id),
    case when s.sheet_kind = 'influencer_candidates' then public.lume_vertical_by_key('pm_reactions') end,
    public.lume_conversation_vertical(s.source_conversation_id))
  where s.vertical_id is null;
update public.validation_jobs j set vertical_id = coalesce(
    case when j.source = 'hnwi' then public.lume_vertical_by_key('hnwi') end,
    public.lume_campaign_vertical(j.instantly_campaign_id),
    public.lume_campaign_vertical(j.instantly_campaign_id_nolocation))
  where j.vertical_id is null
    and not exists (select 1 from public.telegram_ingests i where i.validation_job_id = j.id and i.vertical_id is not null);
update public.pending_actions a set vertical_id = public.lume_action_vertical(a.payload, a.agent_run_id) where a.vertical_id is null;
update public.lume_tasks t set vertical_id = coalesce(
    public.lume_conversation_vertical(t.conversation_id),
    (select a.vertical_id from public.pending_actions a where a.id = t.action_id))
  where t.vertical_id is null;
