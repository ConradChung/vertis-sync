-- GTM-19 · Hiring Ops Signal (Lume page "Hiring Ops Signal").
--
-- Apify scrapers (hiring daily, expansion daily, new_manager weekly) → only
-- real property-management companies (per-domain company check, cached) →
-- skip companies already in the lead bank or an Instantly campaign → one row
-- per signal with a ready cold email (as Frank, SOP-linted) the owner copies
-- and sends by hand. Nothing is ever sent automatically.
--
-- Driven by Lume's /api/cron/hiring-signal (X-Lume-Hook-Secret). The pg_cron
-- schedule ships separately (…_lume_hiring_signal_cron.sql) and is applied
-- only after the owner approves. Additive only.

-- ── Rows (the sheet) ──────────────────────────────────────────────────────
create table if not exists public.signal_hiring (
  id                bigint generated always as identity primary key,
  dedupe_key        text not null unique,                 -- job:<linkedin job id> | person:<profile url> | news:<canonical url>|<company>
  signal            text not null check (signal in ('hiring','new_manager','expansion')),
  role_tier         text check (role_tier in ('leadership','coordinator')),
  role_title        text,
  headline          text,                                 -- one-line summary (news) / poster or profile headline
  source_url        text,
  posted_at         timestamptz,
  location          text,
  country           text,                                 -- 'US' | 'CA' | null
  company_name      text,
  company_domain    text,                                 -- normalised: no scheme, no www, no path, lowercase
  company_website   text,
  company_phone     text,
  company_linkedin  text,
  person_name       text,
  person_title      text,
  person_linkedin   text,
  pm_fit            text check (pm_fit in ('fit','not_fit','unclear')),
  pm_evidence       text,
  -- null = shown. in_lead_bank | in_campaign | not_pm | pm_unclear | no_domain | duplicate_company | cap_reached | check_failed
  skip_reason       text,
  draft_subject     text,
  draft_body        text,
  draft_status      text check (draft_status in ('ready','needs_edit','failed')),
  draft_violations  jsonb,
  -- processing: pending → done (attempts / lease so one tick at a time handles a row)
  stage             text not null default 'pending' check (stage in ('pending','done')),
  attempts          int not null default 0,
  locked_until      timestamptz,
  last_error        text,
  status            text not null default 'new' check (status in ('new','sent','skipped')),
  decided_by        text,
  decided_at        timestamptz,
  run_id            bigint,
  raw               jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists signal_hiring_status_created on public.signal_hiring (status, created_at desc);
create index if not exists signal_hiring_company_domain on public.signal_hiring (company_domain);
create index if not exists signal_hiring_pending on public.signal_hiring (id) where stage = 'pending';

-- ── Apify runs (one row per started run) ─────────────────────────────────
create table if not exists public.signal_hiring_runs (
  id            bigint generated always as identity primary key,
  lane          text not null check (lane in ('hiring','new_manager','expansion')),
  variant       text not null default 'default',          -- e.g. expansion 'US:en' / 'CA:en'
  actor_id      text not null,
  apify_run_id  text unique,
  dataset_id    text,
  status        text not null default 'starting' check (status in ('starting','started','read','failed')),
  manual        boolean not null default false,
  cap_usd       numeric(10,4) not null check (cap_usd >= 0),
  cost_usd      numeric(10,4),
  items         int,
  inserted      int,
  started_at    timestamptz not null default now(),
  read_at       timestamptz,
  error         text
);
-- At most one run in flight per lane + variant (the claim a tick takes before startRun).
create unique index if not exists signal_hiring_runs_in_flight on public.signal_hiring_runs (lane, variant) where status in ('starting','started');
create index if not exists signal_hiring_runs_lane_time on public.signal_hiring_runs (lane, started_at desc);

-- ── Per-company PM check cache (each company checked once) ───────────────
create table if not exists public.signal_company_checks (
  id            bigint generated always as identity primary key,
  domain        text not null unique,                     -- normalised domain, or 'name:<normalised company name>'
  company_name  text,
  icp_fit       text not null check (icp_fit in ('fit','not_fit','unclear')),
  property_type text,
  evidence      text,
  phone         text,
  website       text,
  cost_usd      numeric(10,4) not null default 0,
  checked_at    timestamptz not null default now()
);

-- ── Spend ledger (all lanes together; the $40/month cap reads it) ────────
-- kind apify: written as a reservation (status 'reserved', usd = the run's
-- maxTotalChargeUsd) and settled to usageTotalUsd when the run is read.
create table if not exists public.signal_hiring_spend (
  id          bigint generated always as identity primary key,
  lane        text not null check (lane in ('hiring','new_manager','expansion')),
  kind        text not null check (kind in ('apify','check','draft','extract')),
  status      text not null default 'settled' check (status in ('reserved','settled','released')),
  usd         numeric(10,4) not null check (usd >= 0),
  run_id      bigint,
  row_id      bigint,
  created_at  timestamptz not null default now(),
  settled_at  timestamptz
);
create index if not exists signal_hiring_spend_time on public.signal_hiring_spend (created_at);
create unique index if not exists signal_hiring_spend_run on public.signal_hiring_spend (run_id) where kind = 'apify';

-- ── Exclusions: companies already in the lead bank or an Instantly campaign ─
-- Normalisers mirror lume/lib/hiring/normalize.ts (normDomain / normCompany;
-- tests/hiring/normalize.test.ts reads this file and checks the patterns).
create or replace function public.signal_norm_domain(x text)
returns text language sql immutable set search_path = public as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(btrim(coalesce(x, ''))), '^[a-z][a-z0-9+.-]*://', ''),
        '^www\.', ''),
      '[/:?#].*$', ''),
    '')
$$;

create or replace function public.signal_norm_company(x text)
returns text language sql immutable set search_path = public as $$
  select nullif(
    btrim(regexp_replace(
      regexp_replace(
        regexp_replace(replace(lower(coalesce(x, '')), '&', ' and '), '[^a-z0-9]+', ' ', 'g'),
        '\m(inc|llc|ltd|corp|corporation|co|company|limited|lp|llp|pllc)\M', ' ', 'g'),
      '\s+', ' ', 'g')),
    '')
$$;

-- One row per matched key: 'domain:<d>' or 'name:<n>', reason 'in_campaign'
-- (a lead in Instantly now: lead_bank state 'active', or a direct push on
-- validation_rows) or 'in_lead_bank' (any other lead_bank row).
create or replace function public.signal_hiring_exclusions(p_domains text[], p_names text[])
returns table (match_key text, reason text)
language sql stable security definer set search_path = public as $$
  with b as (
    select lb.state,
           public.signal_norm_domain(coalesce(nullif(lb.company_domain, ''), nullif(lb.website, ''))) as d1,
           lower(split_part(lb.email, '@', 2)) as d2,
           public.signal_norm_company(lb.company_name) as n
    from public.lead_bank lb
  ),
  dom as (
    select d, bool_or(active) as active from (
      select b.d1 as d, b.state = 'active' as active from b where b.d1 = any(p_domains)
      union all
      select b.d2, b.state = 'active' from b where b.d2 = any(p_domains)
      union all
      select lower(split_part(r.email, '@', 2)), true
      from public.validation_rows r
      where r.instantly_status = 'pushed' and lower(split_part(r.email, '@', 2)) = any(p_domains)
    ) u
    group by d
  ),
  nam as (
    select b.n, bool_or(b.state = 'active') as active from b where b.n = any(p_names) group by b.n
  )
  select 'domain:' || d, case when active then 'in_campaign' else 'in_lead_bank' end from dom
  union all
  select 'name:' || n, case when active then 'in_campaign' else 'in_lead_bank' end from nam
$$;
revoke all on function public.signal_hiring_exclusions(text[], text[]) from public, anon, authenticated;

-- ── Settings (owner-editable) ────────────────────────────────────────────
insert into public.lume_settings (key, value) values ('hiring_signal_config', jsonb_build_object(
  'dry_run', true,
  'lanes', jsonb_build_object('hiring', true, 'new_manager', false, 'expansion', false),
  'monthly_cap_usd', 40,
  'run_cap_usd', jsonb_build_object('hiring', 2, 'new_manager', 3, 'expansion', 1),
  'regions', jsonb_build_array('United States', 'Canada')
)) on conflict (key) do nothing;

-- ── RLS: service role only ───────────────────────────────────────────────
alter table public.signal_hiring          enable row level security;
alter table public.signal_hiring_runs     enable row level security;
alter table public.signal_company_checks  enable row level security;
alter table public.signal_hiring_spend    enable row level security;
revoke all on public.signal_hiring, public.signal_hiring_runs, public.signal_company_checks,
              public.signal_hiring_spend from anon, authenticated;
