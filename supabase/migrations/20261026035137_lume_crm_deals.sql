-- Lume CRM (part 2): deals + activities. One deal per (campaign_id, email);
-- lead_id → lead_bank(id) (bigint) with denormalised display fields.
-- RLS: owner-scoped read via lume_is_owner(); writes via service role only.
create table if not exists public.crm_deals (
  id uuid primary key default gen_random_uuid(),
  campaign_id text not null,
  lead_id bigint references public.lead_bank(id) on delete set null,
  email text not null check (email = lower(email) and length(email) <= 320),
  name text,
  company text,
  city text,
  source text not null default 'instantly' check (source in ('instantly','gmail','muse','user')),
  stage text not null default 'Contacted',
  owner text,
  next_action_at timestamptz,
  next_action text check (next_action is null or length(next_action) <= 300),
  last_activity_at timestamptz,
  won_lost_reason text check (won_lost_reason is null or length(won_lost_reason) <= 300),
  notes text check (notes is null or length(notes) <= 20000),
  followup_flagged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, email)
);
create index if not exists crm_deals_campaign_stage_idx on public.crm_deals (campaign_id, stage);
create index if not exists crm_deals_next_action_idx on public.crm_deals (next_action_at) where next_action_at is not null;
create index if not exists crm_deals_lead_idx on public.crm_deals (lead_id);

create table if not exists public.crm_activities (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.crm_deals(id) on delete cascade,
  kind text not null check (kind in ('sent','opened','replied','bounced','stage_changed','note','meeting')),
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  source text not null check (source in ('instantly','gmail','muse','user','agent')),
  -- events.webhook_id (or an adapter key) so a replayed delivery adds nothing
  dedupe_key text unique,
  created_at timestamptz not null default now()
);
create index if not exists crm_activities_deal_idx on public.crm_activities (deal_id, occurred_at desc);
create index if not exists crm_activities_kind_idx on public.crm_activities (kind, occurred_at desc);

alter table public.crm_deals enable row level security;
alter table public.crm_activities enable row level security;
create policy crm_deals_owner_read on public.crm_deals for select to authenticated using ((select public.lume_is_owner()));
create policy crm_activities_owner_read on public.crm_activities for select to authenticated using ((select public.lume_is_owner()));

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='crm_deals') then
    alter publication supabase_realtime add table public.crm_deals;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='crm_activities') then
    alter publication supabase_realtime add table public.crm_activities;
  end if;
end $$;
