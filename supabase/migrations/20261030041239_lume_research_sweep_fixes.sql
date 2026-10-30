-- Research stale sweep with run ids (follows lume_research_reserved_lag_fixes).
--
-- lume_research_sweep_stale_crawls(minutes): fails crawls pending/running for
-- longer than that (including a pending one that already has an apify_run_id)
-- and returns (id, apify_run_id), so company-research can abort the Apify runs
-- (best effort). lume_research_fail_stale_crawls(minutes) keeps its signature
-- and now returns the count of this sweep.

create or replace function public.lume_research_sweep_stale_crawls(p_minutes integer default 15)
returns table (id uuid, apify_run_id text)
language sql
set search_path = pg_catalog, public
as $$
  update public.company_crawls c
     set status = 'failed',
         error = 'stale: no result after ' || greatest(p_minutes, 1) || ' minutes',
         finished_at = now()
   where c.status in ('pending', 'running')
     and c.created_at < now() - make_interval(mins => greatest(p_minutes, 1))
  returning c.id, c.apify_run_id
$$;
revoke all on function public.lume_research_sweep_stale_crawls(integer) from public, anon, authenticated;
grant execute on function public.lume_research_sweep_stale_crawls(integer) to service_role;

create or replace function public.lume_research_fail_stale_crawls(p_minutes integer default 15)
returns integer
language sql
set search_path = pg_catalog, public
as $$
  select count(*)::int from public.lume_research_sweep_stale_crawls(p_minutes)
$$;
revoke all on function public.lume_research_fail_stale_crawls(integer) from public, anon, authenticated;
grant execute on function public.lume_research_fail_stale_crawls(integer) to service_role;
