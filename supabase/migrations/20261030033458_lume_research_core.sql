-- Research + signal layer, P1 schema (docs/lume/2026-10-29-research-signals-design.md).
--
-- companies               one row per normalized domain (lowercase host, no
--                         scheme / www. / path / port). Fills only from new
--                         research: NO backfill from lead_bank / validation_rows.
-- lead_bank.company_id    nullable link, left null for every existing lead.
-- company_crawls          one Apify crawl snapshot per run (pages, cost, status).
--                         cost_usd holds the estimate while the crawl is
--                         pending/running and the actual Apify cost after, so
--                         the month-to-date sum is always the spend so far.
--                         One active (pending/running) crawl per company.
-- company_facts           extracted values with source URL + verbatim snippet.
--                         History is kept (no uniqueness on company+field);
--                         readers take the newest per field.
-- signals                 dated, expiring signals; one row per
--                         (company, type, dedupe_key). Expiry is filtered at
--                         query time (index on expires_at).
-- jurisdictions           editable config. Ships EMPTY: P4 seeds it after
--                         verifying each act's status.
-- lead_personalization_log which field each lead's copy used, and the text.
--
-- lume_research_month_spend()  sum of this calendar month's (UTC) crawl costs.
-- lume_research_reserve_crawl(company, start_url, estimate, external_usd, cap)
--   the budget gate: under one advisory lock, refuses with budget_exceeded
--   when month spend + external (Apify account usage) + estimate > cap, else
--   inserts the pending crawl carrying the estimate as its cost.
--
-- All tables: RLS on, no policies, no grants to anon/authenticated (service role only).

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  domain text not null unique
    check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
           and domain !~ '^www\.' and length(domain) <= 253),
  name text check (name is null or length(name) <= 300),
  website text check (website is null or (website ~ '^https?://' and length(website) <= 2000)),
  last_crawled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.companies enable row level security;
revoke all on public.companies from anon, authenticated;

alter table public.lead_bank add column company_id uuid references public.companies(id) on delete set null;
create index lead_bank_company_id_idx on public.lead_bank (company_id) where company_id is not null;

create table public.company_crawls (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  start_url text not null check (start_url ~ '^https?://' and length(start_url) <= 2000),
  actor_id text,
  apify_run_id text,
  estimate_usd numeric(10, 4) not null default 0 check (estimate_usd >= 0),
  cost_usd numeric(10, 4) not null default 0 check (cost_usd >= 0),
  pages jsonb check (pages is null or jsonb_typeof(pages) = 'array'),
  page_count int check (page_count is null or page_count >= 0),
  extraction jsonb,
  error text check (error is null or length(error) <= 2000),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index company_crawls_one_active_idx on public.company_crawls (company_id) where status in ('pending', 'running');
create index company_crawls_created_idx on public.company_crawls (created_at);
create index company_crawls_company_idx on public.company_crawls (company_id, created_at desc);
alter table public.company_crawls enable row level security;
revoke all on public.company_crawls from anon, authenticated;

create table public.company_facts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  crawl_id uuid references public.company_crawls(id) on delete set null,
  field text not null check (field in ('pms', 'door_count', 'after_hours', 'city', 'region', 'country')),
  value jsonb not null,
  copy_value jsonb,
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  source_url text not null check (source_url ~ '^https?://' and length(source_url) <= 2000),
  snippet text not null check (length(snippet) between 1 and 1000),
  extracted_at timestamptz not null default now()
);
create index company_facts_company_field_idx on public.company_facts (company_id, field, extracted_at desc);
create index company_facts_crawl_idx on public.company_facts (crawl_id);
alter table public.company_facts enable row level security;
revoke all on public.company_facts from anon, authenticated;

create table public.signals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  signal_type text not null check (signal_type in ('open_role', 'door_growth', 'new_market')),
  detail jsonb not null default '{}'::jsonb,
  source_url text not null check (source_url ~ '^https?://' and length(source_url) <= 2000),
  dedupe_key text not null check (length(btrim(dedupe_key)) between 1 and 300),
  detected_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  unique (company_id, signal_type, dedupe_key)
);
create index signals_expires_at_idx on public.signals (expires_at);
alter table public.signals enable row level security;
revoke all on public.signals from anon, authenticated;

create table public.jurisdictions (
  id uuid primary key default gen_random_uuid(),
  country text not null check (country ~ '^[A-Z]{2}$'),
  region text check (region is null or length(region) <= 100),
  city_match text check (city_match is null or length(city_match) <= 100),
  jurisdiction text not null check (length(jurisdiction) <= 200),
  compliance_name text check (compliance_name is null or length(compliance_name) <= 300),
  authority text check (authority is null or length(authority) <= 300),
  copy_hook text check (copy_hook is null or length(copy_hook) <= 500),
  verified_at timestamptz,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index jurisdictions_match_idx
  on public.jurisdictions (country, lower(coalesce(region, '')), lower(coalesce(city_match, '')));
alter table public.jurisdictions enable row level security;
revoke all on public.jurisdictions from anon, authenticated;

create table public.lead_personalization_log (
  id uuid primary key default gen_random_uuid(),
  lead_bank_id bigint references public.lead_bank(id) on delete set null,
  lead_email text check (lead_email is null or length(lead_email) <= 320),
  campaign_id text check (campaign_id is null or length(campaign_id) <= 200),
  company_id uuid references public.companies(id) on delete set null,
  fact_id uuid references public.company_facts(id) on delete set null,
  field_used text not null check (length(field_used) between 1 and 80),
  rendered text not null check (length(rendered) <= 2000),
  created_at timestamptz not null default now()
);
create index lead_personalization_log_lead_idx on public.lead_personalization_log (lead_bank_id, created_at desc);
create index lead_personalization_log_campaign_idx on public.lead_personalization_log (campaign_id, created_at desc);
alter table public.lead_personalization_log enable row level security;
revoke all on public.lead_personalization_log from anon, authenticated;

create or replace function public.lume_research_month_spend()
returns numeric
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce(sum(cost_usd), 0)::numeric
    from public.company_crawls
   where created_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc')
$$;
revoke all on function public.lume_research_month_spend() from public, anon, authenticated;
grant execute on function public.lume_research_month_spend() to service_role;

create or replace function public.lume_research_reserve_crawl(
  p_company uuid, p_start_url text, p_estimate numeric, p_external_usd numeric, p_cap numeric
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
set lock_timeout = '5s'
as $$
declare
  v_spend numeric;
  v_external numeric := greatest(coalesce(p_external_usd, 0), 0);
  v_total numeric;
  v_id uuid;
begin
  if p_estimate is null or p_estimate < 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_estimate');
  end if;
  if p_cap is null or p_cap <= 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_cap');
  end if;
  -- One budget decision at a time, so two concurrent runs cannot both fit.
  perform pg_advisory_xact_lock(hashtext('lume_research_budget'));
  v_spend := public.lume_research_month_spend();
  v_total := v_spend + v_external + p_estimate;
  if v_total > p_cap then
    return jsonb_build_object('ok', false, 'error', 'budget_exceeded',
      'month_spend_usd', v_spend, 'external_usd', v_external, 'estimate_usd', p_estimate, 'cap_usd', p_cap);
  end if;
  begin
    insert into public.company_crawls (company_id, status, start_url, estimate_usd, cost_usd)
      values (p_company, 'pending', p_start_url, p_estimate, p_estimate)
      returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'crawl_in_progress');
  end;
  return jsonb_build_object('ok', true, 'crawl_id', v_id,
    'month_spend_usd', v_spend, 'external_usd', v_external, 'estimate_usd', p_estimate, 'cap_usd', p_cap);
end
$$;
revoke all on function public.lume_research_reserve_crawl(uuid, text, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.lume_research_reserve_crawl(uuid, text, numeric, numeric, numeric) to service_role;
