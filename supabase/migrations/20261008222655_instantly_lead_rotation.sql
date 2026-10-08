-- Applied 2026-10-08 via the Supabase MCP (version 20261008222655). Tracked here so the repo matches the DB.
create table if not exists public.lead_bank (
  id bigserial primary key,
  campaign_id text not null,
  email text not null,
  first_name text, last_name text, company_name text, website text, location text,
  personalization text, operating_cities text, timezone text, company_domain text,
  state text not null default 'queued' check (state in ('queued','active','completed','replied','bounced','unsubscribed','skipped')),
  instantly_lead_id text,
  pushed_at timestamptz, finished_at timestamptz, delete_after timestamptz,
  email_reply_count int default 0, email_open_count int default 0, interest_status text, final_status int,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  unique (campaign_id, email)
);
create index if not exists lead_bank_state_idx on public.lead_bank (campaign_id, state, id);
create table if not exists public.rotation_runs (
  id bigserial primary key, campaign_id text not null, ran_at timestamptz default now(),
  in_instantly_before int, archived int, deleted int, pushed int, in_instantly_after int,
  errors jsonb default '[]'::jsonb, note text
);
alter table public.lead_bank enable row level security;
alter table public.rotation_runs enable row level security;
-- temporary: allow anon bulk load from the CSV; dropped in the next migration after the load
create policy lead_bank_anon_load on public.lead_bank for insert to anon with check (true);
