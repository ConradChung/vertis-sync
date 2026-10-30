-- Research reserved lag (follows lume_research_core_fixes).
--
-- Apify's account monthly usage lags behind finished runs. A crawl that
-- finished in the last 10 minutes may not be in the account figure yet, so it
-- stays in lume_research_reserved_usd() at its ACTUAL cost (cost_usd) until
-- then; pending/running crawls still count at their estimate. On the account
-- basis this can count a just-finished run twice for up to 10 minutes: the
-- safe direction for a cap.

create or replace function public.lume_research_reserved_usd()
returns numeric
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce(sum(case when status in ('pending', 'running') then estimate_usd else cost_usd end), 0)::numeric
    from public.company_crawls
   where status in ('pending', 'running')
      or (finished_at is not null and finished_at > now() - interval '10 minutes')
$$;
revoke all on function public.lume_research_reserved_usd() from public, anon, authenticated;
grant execute on function public.lume_research_reserved_usd() to service_role;
