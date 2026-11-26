-- Lume 90-day plan, phase 3: the Signals inbox's own state.
-- /signals shows one row per company, merged in code from signal_hiring,
-- signal_people (+ signal_posts), signal_reddit_mentions and
-- influencer_reactors, which are only read. What the owner does with a row
-- lives here: a status and three manual touches (email, LinkedIn, call),
-- each a tick with its time, plus the deal started from it.
-- account_key is the merge key: 'd:<domain>', 'n:<normalized name>' or
-- 'r:<reddit author>'. Service role only, like every lume_ table. Additive.
create table if not exists public.signal_accounts (
  account_key text primary key check (account_key ~ '^[dnr]:.{1,200}$'),
  company_name text check (company_name is null or length(company_name) <= 300),
  domain text check (domain is null or length(domain) <= 200),
  status text not null default 'new' check (status in ('new', 'working', 'replied', 'dropped')),
  email_touched_at timestamptz,
  linkedin_touched_at timestamptz,
  call_touched_at timestamptz,
  deal_id uuid references public.crm_deals(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.signal_accounts enable row level security;
revoke all on public.signal_accounts from anon, authenticated;
create index if not exists signal_accounts_status_idx on public.signal_accounts (status);
