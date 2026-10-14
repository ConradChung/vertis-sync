-- supabase/migrations/20261014102012_lume_core.sql
-- Lume: the command center's own tables. Everything else Lume shows is a
-- view over tables that already exist (see docs/lume/2026-10-14-lume-design.md).

-- Append-only feed behind the Overview. Written by triggers (next migration)
-- and by Lume's own routes (webhooks, agent, decisions). Never updated.
create table if not exists events (
  id          bigserial primary key,
  type        text not null,            -- 'validation.status', 'ingest.approved', 'reply', 'bounce', 'agent.tool', ...
  source      text,                     -- table or integration: 'validation_jobs', 'instantly', 'lume', 'agent'
  source_id   text,
  campaign_id text,                     -- Instantly campaign id when known
  lead_email  text,
  title       text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists events_created_idx on events (created_at desc);
create index if not exists events_type_idx on events (type, created_at desc);
-- Webhook replays (Instantly retries) must not double-count.
create unique index if not exists events_webhook_dedupe_idx
  on events ((payload->>'webhook_id')) where payload ? 'webhook_id';

-- High-risk actions wait here. claim_status is the atomic-claim slot, same
-- pattern as validation_jobs.finder_status: the decider PATCHes
-- ...&claim_status=eq.awaiting -> claimed and acts only if a row came back.
create table if not exists pending_actions (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null check (kind in (
                        'push_to_instantly','launch_campaign','assign_leads','activate_rule',
                        'send_reply','pause_campaign','resume_campaign','create_campaign',
                        'decide_gate','delete_rule')),
  payload             jsonb not null default '{}'::jsonb,
  risk                text not null default 'high' check (risk in ('high')),
  status              text not null default 'awaiting'
                      check (status in ('awaiting','approved','rejected','executed','failed','expired')),
  claim_status        text not null default 'awaiting' check (claim_status in ('awaiting','claimed')),
  requested_by        text not null default 'user' check (requested_by in ('user','agent','rule')),
  agent_run_id        uuid,
  rule_id             uuid,
  telegram_message_id bigint,
  decided_via         text check (decided_via in ('lume','telegram')),
  decided_at          timestamptz,
  result              jsonb,
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists pending_actions_open_idx on pending_actions (status) where status = 'awaiting';
drop trigger if exists set_pending_actions_updated_at on pending_actions;
create trigger set_pending_actions_updated_at before update on pending_actions
  for each row execute function update_updated_at_column();   -- from 20260322000001

create table if not exists agent_runs (
  id                 uuid primary key default gen_random_uuid(),
  prompt             text not null,
  status             text not null default 'running'
                     check (status in ('running','needs_approval','done','failed')),
  plan               jsonb,
  tool_calls         jsonb not null default '[]'::jsonb,
  approval_action_id uuid references pending_actions(id),
  outcome            text,
  model              text,
  usage              jsonb,
  created_at         timestamptz not null default now(),
  finished_at        timestamptz
);
-- `add constraint` is not idempotent; drop first so the file can be re-applied.
alter table pending_actions drop constraint if exists pending_actions_agent_run_fk;
alter table pending_actions
  add constraint pending_actions_agent_run_fk foreign key (agent_run_id) references agent_runs(id);

-- Cron-driven assignment rules. The tick never pushes: it creates a
-- pending_actions row (kind assign_leads) and pings Telegram.
create table if not exists rotation_rules (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  campaign_id  text not null,                   -- lume_campaigns.external_id
  filter       jsonb not null default '{}'::jsonb,  -- {source, icp_status, city, since}
  daily_cap    int  not null default 40 check (daily_cap > 0),
  order_by     text not null default 'newest' check (order_by in ('newest','oldest')),
  cron         text not null,
  active       boolean not null default false,
  next_run_at  timestamptz,
  last_run_at  timestamptz,
  last_result  jsonb,
  created_at   timestamptz not null default now()
);
alter table pending_actions drop constraint if exists pending_actions_rule_fk;
alter table pending_actions
  add constraint pending_actions_rule_fk foreign key (rule_id) references rotation_rules(id) on delete set null;

-- Unified campaign registry. `campaigns` already exists for the CRM, hence the prefix.
create table if not exists lume_campaigns (
  id                    uuid primary key default gen_random_uuid(),
  family                text not null check (family in ('kaspen','recruiter','muse','other')),
  name                  text not null,
  external_id           text,                   -- Instantly campaign id; null for gmail/muse
  sender_type           text not null check (sender_type in ('instantly','gmail','muse')),
  status                text not null default 'unknown',   -- draft|active|paused|completed|manual|unknown
  capacity_per_day      int,
  opportunity_value_usd numeric,
  instantly             jsonb,                  -- raw campaign object from the last sync
  synced_at             timestamptz,
  created_at            timestamptz not null default now(),
  unique (sender_type, external_id)
);
-- Seed the two non-Instantly senders. The unique key is (sender_type, external_id)
-- and external_id is NULL here, so `on conflict do nothing` would never match
-- (NULLs are distinct) and re-applying would insert duplicates. Guard on
-- (sender_type, name) instead.
insert into lume_campaigns (family, name, sender_type, status)
select v.family, v.name, v.sender_type, v.status
from (values
  ('recruiter', 'Recruiter · GTM engineers (Gmail)', 'gmail', 'manual'),
  ('muse',      'Muse auto-apply',                    'muse',  'manual')
) as v(family, name, sender_type, status)
where not exists (
  select 1 from lume_campaigns c where c.sender_type = v.sender_type and c.name = v.name
);

-- Crons that live outside pg_cron (Claude scheduled tasks, Vercel crons).
create table if not exists lume_external_schedules (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  cron         text not null,
  target       text not null,
  runner       text not null check (runner in ('claude','vercel','other')),
  last_status  text,
  last_run_at  timestamptz,
  notes        text,
  created_at   timestamptz not null default now()
);
insert into lume_external_schedules (name, cron, target, runner, notes) values
  ('job-scrape',    '0 9 */2 * *', 'jobsearch-notify',  'claude', 'Every other day; inserts job_batches then POSTs jobsearch-notify'),
  ('pm-reactions',  '0 10 * * 1',  'pm-reactions',      'claude', 'Weekly influencer reaction pull (external repo)')
on conflict (name) do nothing;

-- RLS: on everywhere; the one authenticated Lume user may read the three
-- tables the browser subscribes to. Every write goes through the service role.
alter table events enable row level security;
alter table pending_actions enable row level security;
alter table agent_runs enable row level security;
alter table rotation_rules enable row level security;
alter table lume_campaigns enable row level security;
alter table lume_external_schedules enable row level security;
-- `create policy` is not idempotent; drop first so the file can be re-applied.
drop policy if exists events_auth_read on events;
drop policy if exists pending_actions_auth_read on pending_actions;
drop policy if exists agent_runs_auth_read on agent_runs;
create policy events_auth_read on events for select to authenticated using (true);
create policy pending_actions_auth_read on pending_actions for select to authenticated using (true);
create policy agent_runs_auth_read on agent_runs for select to authenticated using (true);

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='events') then
    alter publication supabase_realtime add table public.events;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='pending_actions') then
    alter publication supabase_realtime add table public.pending_actions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='agent_runs') then
    alter publication supabase_realtime add table public.agent_runs;
  end if;
end $$;
