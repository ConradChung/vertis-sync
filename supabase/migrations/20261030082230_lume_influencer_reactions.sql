-- PM influencer reactions pipeline (Lume built-in skill "PM influencer reactions → Apollo CSV").
-- Port of ~/Downloads/pm-reactions-pipeline (run 2026-10-08, all 26 influencers).
--
-- influencers            the people whose post reactions we mine, with their
--                        last run's yield and cost (seeded below from the
--                        2026-10-08 run; zero-yield ones carry a note).
-- influencer_runs        one pipeline run: status + stage, the selected
--                        influencers, per-stage counts, estimated and actual cost
--                        per vendor (apify_posts, apify_reactions, perplexity,
--                        anthropic), the exact reactions bill from stage 2, the
--                        Perplexity cap (max_verify_usd), a lease for the edge
--                        function's hand-off chain. One active run at a time.
-- influencer_apify_runs  every Apify run a pipeline run started (posts or
--                        reactions, one per influencer per run, so a dataset is
--                        never paid for twice). cost_usd holds the reserved
--                        maximum while pending/running, the actual cost after,
--                        exactly like company_crawls, and it counts against the
--                        same monthly Apify cap.
-- influencer_posts       posts pulled in stage 1, Haiku relevance, top-10 rank.
-- influencer_reactors    reactors deduped by linkedin_url across all runs:
--                        reacted_to (influencer slugs), reacted_posts (post ids),
--                        triage / verify verdicts, door count + source +
--                        confidence, first/last seen run, exported_at.
-- influencer_exports     one Apollo CSV export (filters + the reactor ids in it).
--
-- Budget: lume_research_reserved_usd() and lume_research_month_spend() now
-- also count influencer_apify_runs, so company-research's gate and
-- lume_influencer_reserve_apify() share one monthly cap
-- (LUME_RESEARCH_APIFY_CAP_USD) and one advisory lock.
--
-- All tables: RLS on, no policies, no grants to anon/authenticated (service role only).

create table public.influencers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  linkedin_url text not null unique check (linkedin_url ~ '^https://(www\.)?linkedin\.com/in/[^/?#\s]+/?$' and length(linkedin_url) <= 300),
  lookback_days int not null default 90 check (lookback_days between 7 and 730),
  max_reactions_per_post int not null default 1000 check (max_reactions_per_post between 1 and 1000),
  active boolean not null default true,
  notes text check (notes is null or length(notes) <= 1000),
  last_ran_at timestamptz,
  last_posts int check (last_posts is null or last_posts >= 0),
  last_top_posts int check (last_top_posts is null or last_top_posts >= 0),
  last_reactions int check (last_reactions is null or last_reactions >= 0),
  last_reactors int check (last_reactors is null or last_reactors >= 0),
  last_leads int check (last_leads is null or last_leads >= 0),
  last_leads_700 int check (last_leads_700 is null or last_leads_700 >= 0),
  last_apify_usd numeric(10, 4) check (last_apify_usd is null or last_apify_usd >= 0),
  last_perplexity_usd numeric(10, 4) check (last_perplexity_usd is null or last_perplexity_usd >= 0),
  last_haiku_usd numeric(10, 4) check (last_haiku_usd is null or last_haiku_usd >= 0),
  last_cost_usd numeric(10, 4) check (last_cost_usd is null or last_cost_usd >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.influencers enable row level security;
revoke all on public.influencers from anon, authenticated;

create table public.influencer_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running'
    check (status in ('running', 'awaiting_approval', 'done', 'failed', 'cancelled', 'imported')),
  stage text not null default 'posts'
    check (stage in ('posts', 'top_posts', 'reactions', 'triage', 'verify', 'doors', 'output')),
  influencer_ids uuid[] not null check (cardinality(influencer_ids) between 1 and 100),
  start_action_id uuid unique,
  reactions_action_id uuid unique,
  max_verify_usd numeric(10, 2) not null default 10 check (max_verify_usd > 0 and max_verify_usd <= 50),
  reactions_estimate jsonb check (reactions_estimate is null or jsonb_typeof(reactions_estimate) = 'array'),
  reactions_estimate_usd numeric(10, 4) check (reactions_estimate_usd is null or reactions_estimate_usd >= 0),
  reactions_approved_usd numeric(10, 4) check (reactions_approved_usd is null or reactions_approved_usd >= 0),
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object'),
  estimate jsonb not null default '{}'::jsonb check (jsonb_typeof(estimate) = 'object'),
  cost jsonb not null default '{}'::jsonb check (jsonb_typeof(cost) = 'object'),
  error text check (error is null or length(error) <= 2000),
  notes text check (notes is null or length(notes) <= 2000),
  lease_token uuid,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  awaiting_since timestamptz,
  approved_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index influencer_runs_one_active_idx on public.influencer_runs ((true))
  where status in ('running', 'awaiting_approval');
create index influencer_runs_created_idx on public.influencer_runs (created_at desc);
alter table public.influencer_runs enable row level security;
revoke all on public.influencer_runs from anon, authenticated;

create table public.influencer_apify_runs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.influencer_runs(id) on delete cascade,
  influencer_id uuid not null references public.influencers(id) on delete cascade,
  kind text not null check (kind in ('posts', 'reactions')),
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed', 'aborted')),
  actor_id text not null check (length(actor_id) <= 200),
  apify_run_id text check (apify_run_id is null or apify_run_id ~ '^[A-Za-z0-9]{8,40}$'),
  dataset_id text check (dataset_id is null or dataset_id ~ '^[A-Za-z0-9]{8,40}$'),
  estimate_usd numeric(10, 4) not null default 0 check (estimate_usd >= 0),
  cost_usd numeric(10, 4) not null default 0 check (cost_usd >= 0),
  item_count int check (item_count is null or item_count >= 0),
  ingested_at timestamptz,
  error text check (error is null or length(error) <= 2000),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (run_id, influencer_id, kind)
);
create index influencer_apify_runs_active_idx on public.influencer_apify_runs (status) where status in ('pending', 'running');
create index influencer_apify_runs_created_idx on public.influencer_apify_runs (created_at);
alter table public.influencer_apify_runs enable row level security;
revoke all on public.influencer_apify_runs from anon, authenticated;

create table public.influencer_posts (
  run_id uuid not null references public.influencer_runs(id) on delete cascade,
  influencer_id uuid not null references public.influencers(id) on delete cascade,
  post_id text not null check (length(post_id) between 1 and 100),
  post_url text not null check (length(post_url) <= 2000),
  posted_at timestamptz,
  likes int not null default 0 check (likes >= 0),
  comments int not null default 0 check (comments >= 0),
  shares int not null default 0 check (shares >= 0),
  text text check (text is null or length(text) <= 4000),
  pm_relevant boolean,
  relevance_reason text check (relevance_reason is null or length(relevance_reason) <= 500),
  rank int check (rank is null or rank between 1 and 100),
  primary key (run_id, influencer_id, post_id)
);
alter table public.influencer_posts enable row level security;
revoke all on public.influencer_posts from anon, authenticated;

create table public.influencer_reactors (
  id bigint generated always as identity primary key,
  linkedin_url text not null unique check (linkedin_url ~ '^https://(www\.)?linkedin\.com/' and length(linkedin_url) <= 300),
  linkedin_id text check (linkedin_id is null or length(linkedin_id) <= 100),
  name text check (name is null or length(name) <= 300),
  headline text check (headline is null or length(headline) <= 1000),
  reacted_to text[] not null default '{}',
  reacted_posts text[] not null default '{}',
  influencer_count int generated always as (cardinality(reacted_to)) stored,
  reaction_count int generated always as (cardinality(reacted_posts)) stored,
  triage text check (triage is null or triage in ('likely', 'possible', 'no')),
  triaged_at timestamptz,
  verdict text check (verdict is null or verdict in ('verified', 'rejected', 'error')),
  verify_attempts int not null default 0 check (verify_attempts >= 0),
  verified_at timestamptz,
  verified_run uuid references public.influencer_runs(id) on delete set null,
  verify_reason text check (verify_reason is null or length(verify_reason) <= 2000),
  title text check (title is null or length(title) <= 300),
  company_name text check (company_name is null or length(company_name) <= 300),
  company_website text check (company_website is null or length(company_website) <= 500),
  location text check (location is null or length(location) <= 300),
  city text check (city is null or length(city) <= 120),
  state text check (state is null or length(state) <= 120),
  country text check (country is null or length(country) <= 120),
  door_count int check (door_count is null or door_count >= 0),
  door_count_source text check (door_count_source is null or (door_count_source ~ '^https?://' and length(door_count_source) <= 2000)),
  door_count_confidence text check (door_count_confidence is null or door_count_confidence in ('high', 'medium', 'low')),
  door_retried boolean not null default false,
  citations text[] not null default '{}',
  pplx_cost_usd numeric(10, 4) not null default 0 check (pplx_cost_usd >= 0),
  first_seen_run uuid references public.influencer_runs(id) on delete set null,
  last_seen_run uuid references public.influencer_runs(id) on delete set null,
  exported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((door_count is null) = (door_count_source is null) and (door_count is null) = (door_count_confidence is null))
);
create index influencer_reactors_last_seen_idx on public.influencer_reactors (last_seen_run);
create index influencer_reactors_verdict_idx on public.influencer_reactors (verdict, door_count) where verdict = 'verified';
create index influencer_reactors_reacted_to_idx on public.influencer_reactors using gin (reacted_to);
alter table public.influencer_reactors enable row level security;
revoke all on public.influencer_reactors from anon, authenticated;

create table public.influencer_exports (
  id uuid primary key default gen_random_uuid(),
  filters jsonb not null default '{}'::jsonb check (jsonb_typeof(filters) = 'object'),
  reactor_ids bigint[] not null check (cardinality(reactor_ids) between 1 and 20000),
  row_count int not null check (row_count >= 1),
  created_at timestamptz not null default now()
);
alter table public.influencer_exports enable row level security;
revoke all on public.influencer_exports from anon, authenticated;

-- Approvals: one awaiting run start at a time; one awaiting reactions approval per run.
alter table public.pending_actions drop constraint if exists pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly', 'launch_campaign', 'assign_leads', 'activate_rule', 'send_reply', 'pause_campaign',
  'resume_campaign', 'create_campaign', 'decide_gate', 'delete_rule', 'crm_close_deal', 'run_actor',
  'update_sequence', 'issue_operator_key', 'remove_leads', 'label_reply',
  'influencer_run', 'influencer_reactions'
]));
create unique index if not exists pending_actions_one_awaiting_influencer_run_idx
  on public.pending_actions (kind, (payload->>'pipeline'))
  where status = 'awaiting' and kind = 'influencer_run';
create unique index if not exists pending_actions_one_awaiting_influencer_reactions_idx
  on public.pending_actions (kind, (payload->>'run_id'))
  where status = 'awaiting' and kind = 'influencer_reactions';

-- Shared Apify budget ---------------------------------------------------------
-- Same semantics as company_crawls: pending/running at their reserved
-- estimate, runs finished in the last 10 minutes at their actual cost (Apify's
-- account usage lags), month spend = this calendar month's costs.
create or replace function public.lume_research_reserved_usd()
returns numeric
language sql
stable
set search_path = pg_catalog, public
as $$
  select
    (select coalesce(sum(case when status in ('pending', 'running') then estimate_usd else cost_usd end), 0)
       from public.company_crawls
      where status in ('pending', 'running')
         or (finished_at is not null and finished_at > now() - interval '10 minutes'))
  + (select coalesce(sum(case when status in ('pending', 'running') then estimate_usd else cost_usd end), 0)
       from public.influencer_apify_runs
      where status in ('pending', 'running')
         or (finished_at is not null and finished_at > now() - interval '10 minutes'))
$$;
revoke all on function public.lume_research_reserved_usd() from public, anon, authenticated;
grant execute on function public.lume_research_reserved_usd() to service_role;

create or replace function public.lume_research_month_spend()
returns numeric
language sql
stable
set search_path = pg_catalog, public
as $$
  select
    (select coalesce(sum(cost_usd), 0) from public.company_crawls
      where created_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc'))
  + (select coalesce(sum(cost_usd), 0) from public.influencer_apify_runs
      where created_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc'))
$$;
revoke all on function public.lume_research_month_spend() from public, anon, authenticated;
grant execute on function public.lume_research_month_spend() to service_role;

-- The gate for one Apify start (posts or reactions of one influencer in one
-- run). Same lock and same basis as lume_research_reserve_crawl. An existing
-- row for (run, influencer, kind) is returned as-is (existing: true) and never
-- reserved twice: the caller resumes it instead of starting a second run.
create or replace function public.lume_influencer_reserve_apify(
  p_run uuid, p_influencer uuid, p_kind text, p_actor text, p_estimate numeric, p_external_usd numeric, p_cap numeric
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
set lock_timeout = '5s'
as $$
declare
  v_account numeric := case when p_external_usd is not null and p_external_usd >= 0 then p_external_usd end;
  v_basis text := case when p_external_usd is not null and p_external_usd >= 0 then 'account' else 'ledger' end;
  v_reserved numeric;
  v_spend numeric;
  v_committed numeric;
  v_row public.influencer_apify_runs;
  v_parts jsonb;
begin
  if p_estimate is null or p_estimate < 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_estimate');
  end if;
  if p_cap is null or p_cap <= 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_cap');
  end if;
  perform pg_advisory_xact_lock(hashtext('lume_research_budget'));
  select * into v_row from public.influencer_apify_runs
   where run_id = p_run and influencer_id = p_influencer and kind = p_kind;
  if found then
    return jsonb_build_object('ok', true, 'existing', true, 'id', v_row.id, 'status', v_row.status,
      'apify_run_id', v_row.apify_run_id, 'dataset_id', v_row.dataset_id);
  end if;
  v_reserved := public.lume_research_reserved_usd();
  v_spend := public.lume_research_month_spend();
  v_committed := case when v_basis = 'account' then v_account + v_reserved else v_spend end;
  v_parts := jsonb_build_object(
    'basis', v_basis, 'account_usd', v_account, 'reserved_usd', v_reserved, 'month_spend_usd', v_spend,
    'committed_usd', v_committed, 'estimate_usd', p_estimate, 'cap_usd', p_cap);
  if v_committed + p_estimate > p_cap then
    return jsonb_build_object('ok', false, 'error', 'budget_exceeded') || v_parts;
  end if;
  insert into public.influencer_apify_runs (run_id, influencer_id, kind, actor_id, status, estimate_usd, cost_usd)
    values (p_run, p_influencer, p_kind, p_actor, 'pending', p_estimate, p_estimate)
    returning * into v_row;
  return jsonb_build_object('ok', true, 'existing', false, 'id', v_row.id, 'status', 'pending') || v_parts;
end
$$;
revoke all on function public.lume_influencer_reserve_apify(uuid, uuid, text, text, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.lume_influencer_reserve_apify(uuid, uuid, text, text, numeric, numeric, numeric) to service_role;

-- Lease for the edge function's hand-off chain: a fresh invocation claims a
-- running run when its lease is free or expired, or when it holds the token
-- of the invocation that handed off (p_prev). A duplicate delivery of the same
-- hand-off loses: the first claim already replaced p_prev with its own token.
create or replace function public.lume_influencer_claim_run(p_run uuid, p_prev uuid, p_token uuid, p_lease_seconds int default 170)
returns setof public.influencer_runs
language sql
set search_path = pg_catalog, public
as $$
  update public.influencer_runs
     set lease_token = p_token,
         lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 10)),
         heartbeat_at = now(),
         updated_at = now()
   where id = p_run
     and status = 'running'
     and (lease_until is null or lease_until < now() or (p_prev is not null and lease_token = p_prev))
  returning *
$$;
revoke all on function public.lume_influencer_claim_run(uuid, uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.lume_influencer_claim_run(uuid, uuid, uuid, int) to service_role;

-- Merge one Apify reactions dataset into influencer_reactors, exactly once
-- (claims the apify row's ingested_at under a row lock). p_rows: one object
-- per reactor in this dataset: {linkedin_url, linkedin_id, name, headline,
-- slug, post_ids: [...]}. reacted_to / reacted_posts are set unions, so a
-- re-run never double-counts. Returns {merged, new_reactors} or
-- {already_ingested: true}.
create or replace function public.lume_influencer_merge_reactions(p_apify_row uuid, p_rows jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_apify public.influencer_apify_runs;
  v_new int;
  v_total int;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be an array';
  end if;
  select * into v_apify from public.influencer_apify_runs where id = p_apify_row for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_apify.ingested_at is not null then
    return jsonb_build_object('ok', true, 'already_ingested', true);
  end if;
  with src as (
    select btrim(r->>'linkedin_url') as url,
           nullif(btrim(r->>'linkedin_id'), '') as lid,
           left(nullif(btrim(r->>'name'), ''), 300) as nm,
           left(nullif(btrim(r->>'headline'), ''), 1000) as hl,
           r->>'slug' as slug,
           array(select jsonb_array_elements_text(coalesce(r->'post_ids', '[]'::jsonb))) as posts
      from jsonb_array_elements(p_rows) r
     where coalesce(btrim(r->>'linkedin_url'), '') ~ '^https://(www\.)?linkedin\.com/'
  ), up as (
    insert into public.influencer_reactors as t
      (linkedin_url, linkedin_id, name, headline, reacted_to, reacted_posts, first_seen_run, last_seen_run)
    select url, lid, nm, hl, array[slug], posts, v_apify.run_id, v_apify.run_id from src
    on conflict (linkedin_url) do update set
      linkedin_id = coalesce(t.linkedin_id, excluded.linkedin_id),
      name = coalesce(excluded.name, t.name),
      headline = coalesce(t.headline, excluded.headline),
      reacted_to = array(select distinct x from unnest(t.reacted_to || excluded.reacted_to) x order by 1),
      reacted_posts = array(select distinct x from unnest(t.reacted_posts || excluded.reacted_posts) x order by 1),
      last_seen_run = excluded.last_seen_run,
      updated_at = now()
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) into v_new, v_total from up;
  update public.influencer_apify_runs set ingested_at = now() where id = p_apify_row;
  return jsonb_build_object('ok', true, 'merged', v_total, 'new_reactors', v_new);
end
$$;
revoke all on function public.lume_influencer_merge_reactions(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.lume_influencer_merge_reactions(uuid, jsonb) to service_role;

-- Fail running runs whose hand-off chain died (no heartbeat for p_minutes and
-- no live lease) and their pending/running Apify rows (cost stays at the
-- reserved estimate). Returns the Apify run ids to abort, best effort.
create or replace function public.lume_influencer_sweep_stale(p_minutes integer default 30)
returns table (run_id uuid, apify_run_id text)
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_runs uuid[];
begin
  with swept as (
    update public.influencer_runs r
       set status = 'failed',
           error = 'stale: no progress for ' || greatest(p_minutes, 1) || ' minutes',
           finished_at = now(), updated_at = now(), lease_token = null, lease_until = null
     where r.status = 'running'
       and coalesce(r.heartbeat_at, r.created_at) < now() - make_interval(mins => greatest(p_minutes, 1))
       and (r.lease_until is null or r.lease_until < now())
    returning r.id
  )
  select coalesce(array_agg(id), '{}') into v_runs from swept;
  return query
    update public.influencer_apify_runs a
       set status = 'failed', error = 'stale run', finished_at = now()
     where a.run_id = any(v_runs) and a.status in ('pending', 'running')
    returning a.run_id, a.apify_run_id;
end
$$;
revoke all on function public.lume_influencer_sweep_stale(integer) from public, anon, authenticated;
grant execute on function public.lume_influencer_sweep_stale(integer) to service_role;

-- Cancel a running or awaiting run: status cancelled, lease dropped, its
-- pending/running Apify rows marked aborted. Returns the Apify run ids to abort.
create or replace function public.lume_influencer_cancel_run(p_run uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_ids text[];
begin
  update public.influencer_runs
     set status = 'cancelled', finished_at = now(), updated_at = now(), lease_token = null, lease_until = null
   where id = p_run and status in ('running', 'awaiting_approval');
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_active');
  end if;
  with ab as (
    update public.influencer_apify_runs
       set status = 'aborted', finished_at = now(), error = 'cancelled'
     where run_id = p_run and status in ('pending', 'running')
    returning apify_run_id
  )
  select coalesce(array_agg(apify_run_id) filter (where apify_run_id is not null), '{}') into v_ids from ab;
  return jsonb_build_object('ok', true, 'abort', to_jsonb(v_ids));
end
$$;
revoke all on function public.lume_influencer_cancel_run(uuid) from public, anon, authenticated;
grant execute on function public.lume_influencer_cancel_run(uuid) to service_role;

-- Seed: the 26 influencers of the 2026-10-08 full run, with that run's yield
-- and cost per influencer (posts, top posts, reactions, unique reactors,
-- verified leads that reacted to them, leads at 700+ doors; Apify at $2/1k
-- posts + $1.5/1k reactions, Perplexity split by reacted_to, Haiku pro rata).
insert into public.influencers
  (name, slug, linkedin_url, lookback_days, max_reactions_per_post, notes, last_ran_at,
   last_posts, last_top_posts, last_reactions, last_reactors, last_leads, last_leads_700,
   last_apify_usd, last_perplexity_usd, last_haiku_usd, last_cost_usd)
values
  ('Peter Lohmann', 'peter-lohmann', 'https://www.linkedin.com/in/pslohmann', 90, 1000, 'Best yield on 2026-10-07 (pilot): 71 leads, 26 at 700+.', '2026-10-07T12:00:00Z', 317, 10, 1114, 837, 71, 26, 2.31, 0.81, 0.39, 3.51),
  ('Jordan Muela', 'jordan-muela', 'https://www.linkedin.com/in/ACoAAADRVgkBF1xCcg9SknO2689VNDXQ3qJfYRQ', 365, 1000, null, '2026-10-07T12:00:00Z', 15, 7, 177, 132, 11, 3, 0.3, 0.11, 0.05, 0.46),
  ('Deb Newell', 'deb-newell', 'https://www.linkedin.com/in/deb-newell', 365, 1000, null, '2026-10-07T12:00:00Z', 42, 10, 444, 295, 25, 9, 0.75, 0.21, 0.12, 1.08),
  ('Kelli Segretto', 'kelli-segretto', 'https://www.linkedin.com/in/kelli-segretto', 365, 1000, null, '2026-10-07T12:00:00Z', 48, 10, 430, 289, 19, 4, 0.74, 0.25, 0.12, 1.11),
  ('Jennifer Ruelens (PM Jen)', 'jennifer-ruelens', 'https://www.linkedin.com/in/jenniferruelens', 90, 1000, null, '2026-10-07T12:00:00Z', 68, 10, 324, 200, 16, 3, 0.62, 0.16, 0.09, 0.87),
  ('Mark Brower', 'mark-brower', 'https://www.linkedin.com/in/ACoAAAD5qoEB5yClg_-6O8yBwU0DfGg7Q56qoYE', 365, 1000, null, '2026-10-07T12:00:00Z', 274, 10, 677, 479, 20, 5, 1.56, 0.21, 0.24, 2.01),
  ('Allison DiSarro', 'allison-disarro', 'https://www.linkedin.com/in/ACoAAAy17WMB24z7xIMHgunhQaQP85GNECx6cQc', 365, 1000, '0 leads on 2026-10-08 (4 posts, 57 reactions).', '2026-10-08T12:00:00Z', 4, 2, 57, 52, 0, 0, 0.09, 0.02, 0.02, 0.13),
  ('Andrew R. Smallwood', 'andrew-r-smallwood', 'https://www.linkedin.com/in/ACoAAAHp8T8BvXvW3a9h1Oa5_MixIr8Bh-5XJXc', 365, 1000, null, '2026-10-08T12:00:00Z', 31, 10, 780, 510, 10, 3, 1.23, 0.23, 0.21, 1.67),
  ('Jay Parsons', 'jay-parsons', 'https://www.linkedin.com/in/jay-parsons-a7a6656', 365, 150, 'Big audience; capped at 150 reactions per post. Multifamily operators: 24 of 39 leads at 700+.', '2026-10-08T12:00:00Z', 184, 10, 1500, 1410, 39, 24, 2.62, 1.85, 0.59, 5.06),
  ('Moshe Crane', 'moshe-crane', 'https://www.linkedin.com/in/ACoAAAIwPGMBp3ZSjboV0aWnU3oGKSV0-JlXLxo', 365, 100, null, '2026-10-08T12:00:00Z', 148, 10, 974, 814, 11, 7, 1.76, 1.13, 0.35, 3.24),
  ('Mike Wolber', 'mike-wolber', 'https://www.linkedin.com/in/ACoAABfkfrgBzPQuTe2QLHRZePgrRMXtg1uQc6U', 365, 150, null, '2026-10-08T12:00:00Z', 230, 10, 1500, 1104, 1, 1, 2.71, 0.71, 0.48, 3.9),
  ('Barbara Savona', 'barbara-savona', 'https://www.linkedin.com/in/barbarasavona', 365, 1000, 'Zero yield on 2026-10-08: no posts in the last 365 days.', '2026-10-08T12:00:00Z', 0, 0, 0, 0, 0, 0, 0.0, 0, 0.0, 0.0),
  ('Ryan Barone', 'ryan-barone', 'https://www.linkedin.com/in/ryanebarone', 365, 1000, '0 leads on 2026-10-08 (1 post, 50 reactions).', '2026-10-08T12:00:00Z', 1, 1, 50, 50, 0, 0, 0.08, 0.0, 0.02, 0.1),
  ('Brandon Turner', 'brandon-turner', 'https://www.linkedin.com/in/brandon-turner-1b96b6209', 365, 300, null, '2026-10-08T12:00:00Z', 37, 10, 773, 627, 9, 2, 1.23, 0.4, 0.25, 1.88),
  ('DD Garzon (Lee)', 'dd-garzon', 'https://www.linkedin.com/in/dd-garzon', 365, 1000, 'Zero yield on 2026-10-08: no posts in the last 365 days.', '2026-10-08T12:00:00Z', 0, 0, 0, 0, 0, 0, 0.0, 0, 0.0, 0.0),
  ('Lior Abramovich', 'lior-abramovich', 'https://www.linkedin.com/in/ACoAAAgx_QQBrux0UBeRWKfA5AoOcpzm3MwWqtk', 365, 1000, null, '2026-10-08T12:00:00Z', 117, 10, 782, 419, 15, 6, 1.41, 0.2, 0.19, 1.8),
  ('Bess Wozniak', 'bess-wozniak', 'https://www.linkedin.com/in/ACoAAAuXcpQBOQLUEkq_nUMzQ3xMo5BZsO4vgDc', 365, 1000, '0 leads on 2026-10-08 (5 posts, 69 reactions).', '2026-10-08T12:00:00Z', 5, 3, 69, 59, 0, 0, 0.11, 0.0, 0.02, 0.13),
  ('Angela Holman', 'angela-holman', 'https://www.linkedin.com/in/angela-holman', 365, 1000, 'Zero yield on 2026-10-08: no PM-relevant posts.', '2026-10-08T12:00:00Z', 1, 0, 0, 0, 0, 0, 0.0, 0, 0.0, 0.0),
  ('Grady Newman', 'grady-newman', 'https://www.linkedin.com/in/gradynewman', 365, 1000, null, '2026-10-08T12:00:00Z', 105, 10, 614, 418, 2, 1, 1.13, 0.32, 0.19, 1.64),
  ('Mike Brewer', 'mike-brewer', 'https://www.linkedin.com/in/ACoAAABpZJkBX-OG4-IyKKCCyMPJpOApicop_BQ', 365, 1000, 'Zero yield on 2026-10-08: vendor audience (626 reactions, 0 verified leads).', '2026-10-08T12:00:00Z', 114, 10, 626, 449, 0, 0, 1.17, 0.42, 0.2, 1.79),
  ('Stacey Arias', 'stacey-arias', 'https://www.linkedin.com/in/stacey-arias-5a75b2143', 365, 1000, null, '2026-10-08T12:00:00Z', 4, 2, 229, 209, 4, 3, 0.35, 0.35, 0.08, 0.78),
  ('Kristin Anikewich', 'kristin-anikewich', 'https://www.linkedin.com/in/kristinanike18', 365, 1000, 'Zero yield on 2026-10-08: no posts in the last 365 days.', '2026-10-08T12:00:00Z', 0, 0, 0, 0, 0, 0, 0.0, 0, 0.0, 0.0),
  ('David Rintz', 'david-rintz', 'https://www.linkedin.com/in/david-rintz-97ab194', 365, 1000, 'Zero yield on 2026-10-08: no PM-relevant posts (11 posts).', '2026-10-08T12:00:00Z', 11, 0, 0, 0, 0, 0, 0.02, 0, 0.0, 0.02),
  ('Jo-Anne Oliveri', 'jo-anne-oliveri', 'https://www.linkedin.com/in/joanneoliveri', 365, 1000, null, '2026-10-08T12:00:00Z', 105, 10, 201, 82, 4, 1, 0.51, 0.07, 0.05, 0.63),
  ('Ray Hespen', 'ray-hespen', 'https://www.linkedin.com/in/ACoAAAWE2KUBdsV7r4J6a6XrP8Phh5Vpg3F_roU', 365, 1000, null, '2026-10-08T12:00:00Z', 387, 10, 772, 466, 5, 1, 1.93, 0.19, 0.26, 2.38),
  ('Brad Johnson (ProfitCoach)', 'brad-johnson', 'https://www.linkedin.com/in/ACoAAAiLlOwBgP7JU9YsXCVsYibnvUB73gSI2PI', 365, 1000, null, '2026-10-08T12:00:00Z', 158, 10, 939, 761, 24, 7, 1.72, 1.28, 0.33, 3.33);

-- The 2026-10-08 run, as one imported run (aggregate numbers only; the
-- reactors themselves are imported by a one-off service-role script).
insert into public.influencer_runs
  (id, status, stage, influencer_ids, counts, cost, notes, created_at, finished_at)
select '00000000-0000-4000-8000-000000001008', 'imported', 'output', array_agg(id order by created_at),
  jsonb_build_object('influencers', 26, 'with_posts', 21, 'reactions', 13032, 'unique_reactors', 7638,
    'candidates', 1957, 'verified', 254, 'with_door_count', 218, 'leads_700', 97, 'multi_influencer', 22),
  jsonb_build_object('apify_usd', 25, 'perplexity_usd', 8.92, 'anthropic_usd', 3, 'total_usd', 37),
  'Imported from ~/Downloads/pm-reactions-pipeline (pilot 2026-10-07, full run 2026-10-08).',
  '2026-10-08T12:00:00Z', '2026-10-08T23:00:00Z'
from public.influencers;
