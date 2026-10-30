-- pgTAP: research reserved lag (migration lume_research_reserved_lag_fixes):
--   Apify's account usage lags, so a crawl that finished in the last 10 minutes
--   stays in lume_research_reserved_usd() at its ACTUAL cost; pending/running
--   crawls count at their estimate; older finished crawls are left to the
--   account figure. Relative to the live ledger. Everything rolls back.
begin;
select plan(6);

insert into public.companies(id, domain) values
  ('00000000-0000-0000-0000-00000000c201', 'pgtap-lag-a.com'),
  ('00000000-0000-0000-0000-00000000c202', 'pgtap-lag-b.com'),
  ('00000000-0000-0000-0000-00000000c203', 'pgtap-lag-c.com'),
  ('00000000-0000-0000-0000-00000000c204', 'pgtap-lag-d.com');
create temp table lag_base as select public.lume_research_reserved_usd() as reserved;

insert into public.company_crawls(company_id, status, start_url, estimate_usd, cost_usd, finished_at)
  values ('00000000-0000-0000-0000-00000000c201', 'succeeded', 'https://pgtap-lag-a.com/', 0.02, 0.37, now() - interval '5 minutes');
select is(public.lume_research_reserved_usd() - (select reserved from lag_base), 0.37::numeric,
  'a crawl finished 5 minutes ago stays reserved at its actual cost (Apify usage may not show it yet)');

insert into public.company_crawls(company_id, status, start_url, estimate_usd, cost_usd, finished_at)
  values ('00000000-0000-0000-0000-00000000c202', 'failed', 'https://pgtap-lag-b.com/', 0.02, 0.11, now() - interval '2 minutes');
select is(public.lume_research_reserved_usd() - (select reserved from lag_base), 0.48::numeric,
  'failed runs that finished recently count too (they were billed)');

insert into public.company_crawls(company_id, status, start_url, estimate_usd, cost_usd, finished_at)
  values ('00000000-0000-0000-0000-00000000c203', 'succeeded', 'https://pgtap-lag-c.com/', 0.02, 9, now() - interval '11 minutes');
select is(public.lume_research_reserved_usd() - (select reserved from lag_base), 0.48::numeric,
  'a crawl finished more than 10 minutes ago is left to the account figure');

insert into public.company_crawls(company_id, status, start_url, estimate_usd, cost_usd)
  values ('00000000-0000-0000-0000-00000000c204', 'running', 'https://pgtap-lag-d.com/', 0.02, 0.02);
select is(public.lume_research_reserved_usd() - (select reserved from lag_base), 0.50::numeric,
  'a running crawl counts at its estimate');

create temp table lag_now as select public.lume_research_reserved_usd() as reserved;
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c203', 'https://pgtap-lag-c.com/', 0.02, 10,
     10 + (select reserved from lag_now) + 0.02 - 0.0001))->>'error',
  'budget_exceeded', 'the gate counts the recently finished cost on top of a lagging account figure');
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c203', 'https://pgtap-lag-c.com/', 0.02, 10,
     10 + (select reserved from lag_now) + 0.02))->>'ok',
  'true', 'and admits a run that lands exactly on the cap');

select * from finish();
rollback;
