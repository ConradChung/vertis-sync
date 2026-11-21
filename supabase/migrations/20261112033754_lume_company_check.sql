-- Company check: what each company in a validation job really does, and
-- whether it fits the ICP, from one web-research call per company domain.
--
-- company_checks        the cache: one verdict per (company_key, icp_key).
--                       company_key is the company's domain (website, else a
--                       non-free-mail email domain, else 'name:<company>');
--                       icp_key is sha256 of the normalised ICP text. A key
--                       that is here is never paid for again, in any run.
-- company_check_runs    one run per (job, ICP): the owner-approved cap
--                       (max_usd, cumulative), what was spent, the estimate
--                       quoted at approval, the approving action, and a lease
--                       for the company-check edge function's chain.
-- company_check_items   the run's distinct companies (seeded from the job's
--                       valid rows): leads per company, and pending | cached
--                       | done | error.
-- company_check_results view: items + their cached verdict, for Lume.
--
-- The check spends money (Perplexity Sonar + a Haiku parse per company), so
-- it only runs after the owner approves a `company_check` pending action.
-- All tables: RLS on, no policies, no grants to anon/authenticated (service role only).

create table public.company_checks (
  id uuid primary key default gen_random_uuid(),
  company_key text not null check (length(company_key) between 1 and 300),
  icp_key text not null check (icp_key ~ '^[0-9a-f]{64}$'),
  company_name text check (company_name is null or length(company_name) <= 500),
  website text check (website is null or length(website) <= 500),
  what_it_does text not null check (length(what_it_does) <= 1000),
  icp_fit text not null check (icp_fit in ('fit', 'not_fit', 'unclear')),
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  evidence text not null default '' check (length(evidence) <= 500),
  evidence_url text check (evidence_url is null or length(evidence_url) <= 2000),
  citations jsonb not null default '[]'::jsonb check (jsonb_typeof(citations) = 'array'),
  cost_usd numeric(10, 6) not null default 0 check (cost_usd >= 0),
  run_id uuid,
  checked_at timestamptz not null default now(),
  unique (company_key, icp_key)
);
alter table public.company_checks enable row level security;
revoke all on public.company_checks from anon, authenticated;

create table public.company_check_runs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.validation_jobs(id) on delete cascade,
  icp_description text not null check (length(btrim(icp_description)) between 1 and 1000),
  icp_key text not null check (icp_key ~ '^[0-9a-f]{64}$'),
  status text not null default 'staged' check (status in ('staged', 'running', 'done', 'capped', 'cancelled', 'failed')),
  companies_total int not null default 0 check (companies_total >= 0),
  estimate_usd numeric(10, 4) check (estimate_usd is null or estimate_usd >= 0),
  max_usd numeric(10, 4) check (max_usd is null or max_usd > 0),
  spent_usd numeric(10, 6) not null default 0 check (spent_usd >= 0),
  action_id uuid,
  lease_token uuid,
  lease_until timestamptz,
  error text check (error is null or length(error) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (job_id, icp_key)
);
create index company_check_runs_status_idx on public.company_check_runs (status, updated_at desc);
alter table public.company_check_runs enable row level security;
revoke all on public.company_check_runs from anon, authenticated;

alter table public.company_checks
  add constraint company_checks_run_fk foreign key (run_id) references public.company_check_runs(id) on delete set null;

create table public.company_check_items (
  run_id uuid not null references public.company_check_runs(id) on delete cascade,
  company_key text not null check (length(company_key) between 1 and 300),
  company_name text check (company_name is null or length(company_name) <= 500),
  website text check (website is null or length(website) <= 500),
  leads int not null default 0 check (leads >= 0),
  status text not null default 'pending' check (status in ('pending', 'cached', 'done', 'error')),
  attempts int not null default 0 check (attempts >= 0),
  error text check (error is null or length(error) <= 1000),
  cost_usd numeric(10, 6) not null default 0 check (cost_usd >= 0),
  updated_at timestamptz not null default now(),
  primary key (run_id, company_key)
);
create index company_check_items_pending_idx on public.company_check_items (run_id, status, leads desc);
alter table public.company_check_items enable row level security;
revoke all on public.company_check_items from anon, authenticated;

create view public.company_check_results with (security_invoker = true) as
  select i.run_id, r.job_id, i.company_key, i.company_name, i.website, i.leads, i.status, i.attempts, i.error,
         c.what_it_does, c.icp_fit, c.confidence, c.evidence, c.evidence_url, c.checked_at, c.cost_usd as check_cost_usd
    from public.company_check_items i
    join public.company_check_runs r on r.id = i.run_id
    left join public.company_checks c on c.company_key = i.company_key and c.icp_key = r.icp_key;
revoke all on public.company_check_results from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Pure helpers (the one place the company key and ICP key are computed).

create or replace function public.company_check_icp_key(p_icp text) returns text
language sql immutable
set search_path = pg_catalog, public, extensions
as $$
  select encode(sha256(convert_to(btrim(regexp_replace(lower(coalesce(p_icp, '')), '\s+', ' ', 'g')), 'UTF8')), 'hex')
$$;

-- Domain from a website ("https://www.Acme.com/about" -> "acme.com"), else
-- from a non-free-mail email, else 'name:<company, lowercased>'; null when
-- there is nothing to key on.
create or replace function public.company_check_key(p_website text, p_email text, p_company text) returns text
language sql immutable
set search_path = pg_catalog, public
as $$
  with w as (
    select split_part(split_part(split_part(split_part(
             regexp_replace(regexp_replace(lower(btrim(coalesce(p_website, ''))), '^[a-z][a-z0-9+.-]*://', ''), '^www\.', ''),
             '/', 1), '?', 1), '#', 1), ':', 1) as d
  ), e as (
    select lower(btrim(split_part(coalesce(p_email, ''), '@', 2))) as d
  )
  select case
    when (select d from w) ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then left((select d from w), 300)
    when (select d from e) ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' and (select d from e) not in (
      'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
      'aol.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'comcast.net', 'att.net',
      'sbcglobal.net', 'verizon.net', 'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net', 'gmx.com', 'mail.com', 'zoho.com'
    ) then left((select d from e), 300)
    when btrim(coalesce(p_company, '')) <> '' then left('name:' || btrim(regexp_replace(lower(p_company), '\s+', ' ', 'g')), 300)
    else null
  end
$$;

-- The job's company / website / email headers, by the same tiers as
-- operating-city-enricher's detectCompanyColumn / detectWebsiteColumn.
create or replace function public.company_check_columns(p_job_id uuid) returns jsonb
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare
  hdrs text[];
  norm text[];
  co text; site text; mail text;
  i int;
begin
  select column_order into hdrs from public.validation_jobs where id = p_job_id;
  if hdrs is null or cardinality(hdrs) = 0 then
    select array_agg(k) into hdrs from (
      select jsonb_object_keys(row_data) as k from public.validation_rows where job_id = p_job_id and row_data is not null limit 1
    ) s;
  end if;
  if hdrs is null then return jsonb_build_object('company', null, 'website', null, 'email', null); end if;
  select array_agg(regexp_replace(lower(btrim(h)), '\s+', '_', 'g') order by o) into norm from unnest(hdrs) with ordinality as t(h, o);
  for i in 1 .. cardinality(hdrs) loop
    if co is null and norm[i] in ('company_name', 'company', 'business_name', 'organization') then co := hdrs[i]; end if;
    if site is null and norm[i] in ('website', 'domain', 'url', 'web') then site := hdrs[i]; end if;
    if mail is null and norm[i] in ('email', 'email_address', 'work_email') then mail := hdrs[i]; end if;
  end loop;
  for i in 1 .. cardinality(hdrs) loop
    if co is null and (norm[i] like '%company%' or norm[i] like '%business_name%') then co := hdrs[i]; end if;
    if site is null and (norm[i] like '%website%' or norm[i] like '%domain%') then site := hdrs[i]; end if;
    if mail is null and norm[i] like '%email%' and norm[i] not like '%status%' and norm[i] not like '%sent%' then mail := hdrs[i]; end if;
  end loop;
  if co is null then
    for i in 1 .. cardinality(hdrs) loop
      if norm[i] = 'name' then co := hdrs[i]; exit; end if;
    end loop;
  end if;
  return jsonb_build_object('company', co, 'website', site, 'email', mail);
end $$;

-- What a check of this job would cover, before anything is spent: valid
-- leads, distinct companies, those already in the cache for this ICP, and the
-- icp_status the operating-city enrichment already wrote (free).
create or replace function public.company_check_plan(p_job_id uuid, p_icp text) returns jsonb
language plpgsql stable
set search_path = pg_catalog, public, extensions
as $$
declare
  cols jsonb := public.company_check_columns(p_job_id);
  ikey text := public.company_check_icp_key(p_icp);
  out jsonb;
begin
  with v as (
    select public.company_check_key(row_data ->> (cols ->> 'website'), row_data ->> (cols ->> 'email'), row_data ->> (cols ->> 'company')) as k,
           enrichment ->> 'icp_status' as icp_status
      from public.validation_rows
     where job_id = p_job_id and status = 'valid'
  ), ks as (
    select distinct k from v where k is not null
  )
  select jsonb_build_object(
    'icp_key', ikey,
    'columns', cols,
    'valid_leads', (select count(*) from v),
    'leads_without_company', (select count(*) from v where k is null),
    'companies', (select count(*) from ks),
    'companies_by_domain', (select count(*) from ks where k not like 'name:%'),
    'companies_by_name_only', (select count(*) from ks where k like 'name:%'),
    'cached', (select count(*) from ks join public.company_checks c on c.company_key = ks.k and c.icp_key = ikey),
    'enrichment_icp_status', coalesce((select jsonb_object_agg(coalesce(icp_status, 'none'), n) from (
       select icp_status, count(*) as n from v group by icp_status) s), '{}'::jsonb)
  ) into out;
  return out;
end $$;

-- Open (or find) the run for a job + ICP. Returns the run row.
create or replace function public.company_check_open_run(p_job_id uuid, p_icp text) returns public.company_check_runs
language plpgsql
set search_path = pg_catalog, public, extensions
as $$
declare
  ikey text := public.company_check_icp_key(p_icp);
  r public.company_check_runs;
begin
  insert into public.company_check_runs (job_id, icp_description, icp_key)
  values (p_job_id, btrim(p_icp), ikey)
  on conflict (job_id, icp_key) do nothing;
  select * into r from public.company_check_runs where job_id = p_job_id and icp_key = ikey;
  return r;
end $$;

-- Per-status company counts, and companies / leads by ICP verdict.
create or replace function public.company_check_summary(p_run_id uuid) returns jsonb
language sql stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_object_agg(status, n) from (
        select status, count(*) as n from public.company_check_items where run_id = p_run_id group by status) s), '{}'::jsonb),
    'companies_by_fit', coalesce((select jsonb_object_agg(icp_fit, n) from (
        select icp_fit, count(*) as n from public.company_check_results where run_id = p_run_id and icp_fit is not null group by icp_fit) s), '{}'::jsonb),
    'leads_by_fit', coalesce((select jsonb_object_agg(icp_fit, n) from (
        select icp_fit, sum(leads) as n from public.company_check_results where run_id = p_run_id and icp_fit is not null group by icp_fit) s), '{}'::jsonb)
  )
$$;

-- Seed a run's companies from its job's valid rows (idempotent: new
-- companies are added, lead counts refreshed), mark the ones already cached,
-- retry the ones that failed before, and store the total.
create or replace function public.company_check_seed(p_run_id uuid) returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  r public.company_check_runs;
  cols jsonb;
  total int;
begin
  select * into r from public.company_check_runs where id = p_run_id;
  if r.id is null then raise exception 'company_check_seed: run % not found', p_run_id; end if;
  cols := public.company_check_columns(r.job_id);
  insert into public.company_check_items (run_id, company_key, company_name, website, leads)
  select p_run_id, k, left(max(co), 500), left(max(site), 500), count(*)
    from (
      select public.company_check_key(row_data ->> (cols ->> 'website'), row_data ->> (cols ->> 'email'), row_data ->> (cols ->> 'company')) as k,
             nullif(btrim(row_data ->> (cols ->> 'company')), '') as co,
             nullif(btrim(row_data ->> (cols ->> 'website')), '') as site
        from public.validation_rows
       where job_id = r.job_id and status = 'valid'
    ) v
   where k is not null
   group by k
  on conflict (run_id, company_key) do update set leads = excluded.leads;
  update public.company_check_items i set status = 'cached', updated_at = now()
   where i.run_id = p_run_id and i.status in ('pending', 'error')
     and exists (select 1 from public.company_checks c where c.company_key = i.company_key and c.icp_key = r.icp_key);
  update public.company_check_items set status = 'pending', attempts = 0, updated_at = now()
   where run_id = p_run_id and status = 'error';
  select count(*) into total from public.company_check_items where run_id = p_run_id;
  update public.company_check_runs set companies_total = total, updated_at = now() where id = p_run_id;
  return public.company_check_summary(p_run_id);
end $$;

revoke all on function public.company_check_icp_key(text) from public, anon, authenticated;
revoke all on function public.company_check_key(text, text, text) from public, anon, authenticated;
revoke all on function public.company_check_columns(uuid) from public, anon, authenticated;
revoke all on function public.company_check_plan(uuid, text) from public, anon, authenticated;
revoke all on function public.company_check_open_run(uuid, text) from public, anon, authenticated;
revoke all on function public.company_check_seed(uuid) from public, anon, authenticated;
revoke all on function public.company_check_summary(uuid) from public, anon, authenticated;
grant execute on function public.company_check_icp_key(text), public.company_check_key(text, text, text),
  public.company_check_columns(uuid), public.company_check_plan(uuid, text), public.company_check_open_run(uuid, text),
  public.company_check_seed(uuid), public.company_check_summary(uuid) to service_role;

-- The approval: one awaiting per job (pending_actions_one_awaiting_idx keys on payload job_id).
alter table public.pending_actions drop constraint if exists pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly', 'launch_campaign', 'assign_leads', 'activate_rule', 'send_reply', 'pause_campaign',
  'resume_campaign', 'create_campaign', 'decide_gate', 'delete_rule', 'crm_close_deal', 'run_actor',
  'update_sequence', 'issue_operator_key', 'remove_leads', 'label_reply',
  'influencer_run', 'influencer_reactions', 'stage_attachment', 'influencer_lookup', 'influencer_approve',
  'send_lead_list', 'delete_lead_list', 'remove_lead_rows', 'new_campaign', 'company_check'
]));

-- Sweep: a run whose chain died (lease expired while running) is re-kicked by
-- POSTing {action: 'sweep'} to company-check every 5 minutes (same vault
-- entries as lume_influencer_lookup_sweep_tick). Nothing running: no request.
create or replace function public.lume_company_check_sweep_tick() returns void
language plpgsql security definer
set search_path = pg_catalog, public
set lock_timeout = '2s'
as $$
declare
  key text;
  url text;
begin
  if not exists (select 1 from public.company_check_runs
                  where status = 'running' and (lease_until is null or lease_until < now())) then
    return;
  end if;
  select decrypted_secret into key from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into url from vault.decrypted_secrets where name = 'project_url';
  if key is null or url is null then return; end if;
  perform net.http_post(
    url     := url || '/functions/v1/company-check',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || key, 'apikey', key),
    body    := jsonb_build_object('action', 'sweep'));
exception when others then
  raise warning 'lume_company_check_sweep_tick: %', sqlerrm;
end $$;
revoke all on function public.lume_company_check_sweep_tick() from public, anon, authenticated;

select cron.unschedule('company-check-sweep') where exists (
  select 1 from cron.job where jobname = 'company-check-sweep');
select cron.schedule('company-check-sweep', '*/5 * * * *', 'select public.lume_company_check_sweep_tick()');
