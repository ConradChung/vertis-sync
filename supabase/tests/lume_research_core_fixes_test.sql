-- pgTAP: research core fixes (migration lume_research_core_fixes):
--   budget basis — Apify account usage (account-wide, already includes our
--   finished runs) + reservations of our crawls still pending/running; when
--   account usage is unreadable (null), our own month-to-date sum (finished +
--   reserved). Never $0, never a finished run counted twice.
--   lume_research_fail_stale_crawls — pending/running for > N minutes -> failed.
-- Amounts are relative to the live ledger so the test holds on a non-empty table.
-- Everything rolls back.
begin;
select plan(17);

insert into public.companies(id, domain) values
  ('00000000-0000-0000-0000-00000000c101', 'pgtap-fix-a.com'),
  ('00000000-0000-0000-0000-00000000c102', 'pgtap-fix-b.com'),
  ('00000000-0000-0000-0000-00000000c103', 'pgtap-fix-c.com'),
  ('00000000-0000-0000-0000-00000000c104', 'pgtap-fix-d.com');

-- A finished run (billed: Apify's account usage already includes it) and one in flight.
insert into public.company_crawls(company_id, status, start_url, estimate_usd, cost_usd, finished_at)
  values ('00000000-0000-0000-0000-00000000c101', 'succeeded', 'https://pgtap-fix-a.com/', 0.02, 5, now());
insert into public.company_crawls(id, company_id, status, start_url, estimate_usd, cost_usd)
  values ('00000000-0000-0000-0000-0000000cc102', '00000000-0000-0000-0000-00000000c102', 'running', 'https://pgtap-fix-b.com/', 0.02, 0.02);

create temp table base as select public.lume_research_reserved_usd() as reserved, public.lume_research_month_spend() as spend;

-- reserved_usd ---------------------------------------------------------------
select ok((select reserved from base) >= 0.02, 'reserved_usd counts the in-flight crawl''s estimate');
select is(
  public.lume_research_reserved_usd(),
  (select coalesce(sum(estimate_usd), 0) from public.company_crawls where status in ('pending', 'running')),
  'reserved_usd is the estimates of pending/running crawls only (finished runs excluded)');

-- account readable, runs in flight -------------------------------------------
-- committed = 10 (account) + reserved; + 0.02 estimate
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c103', 'https://pgtap-fix-c.com/', 0.02, 10,
     10 + (select reserved from base) + 0.02 - 0.0001))->>'error',
  'budget_exceeded', 'account readable + run in flight: account usage + reservations + estimate over the cap is refused');
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c103', 'https://pgtap-fix-c.com/', 0.02, 10,
     10 + (select reserved from base) + 0.02))->>'ok',
  'true', 'account readable + run in flight: exactly at the cap is accepted (the finished $5 run is not added on top)');
select is(
  (select r->>'basis' from (select public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c104', 'https://pgtap-fix-d.com/', 0.02, 10, 1000000) r) s),
  'account', 'the reply names the basis it used');

-- account readable, all of ours finished ---------------------------------------
update public.company_crawls set status = 'succeeded', cost_usd = 0.01, finished_at = now()
 where company_id in ('00000000-0000-0000-0000-00000000c102', '00000000-0000-0000-0000-00000000c103', '00000000-0000-0000-0000-00000000c104')
   and status in ('pending', 'running');
create temp table base2 as select public.lume_research_reserved_usd() as reserved, public.lume_research_month_spend() as spend;
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c103', 'https://pgtap-fix-c.com/', 0.02, 10,
     10 + (select reserved from base2) + 0.02))->>'ok',
  'true', 'account readable + all ours finished: no double count (finished costs are inside the account figure)');
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c101', 'https://pgtap-fix-a.com/', 0.02, 10,
     10 + (select reserved from base2) + 0.02 + 0.02 - 0.0001))->>'error',
  'budget_exceeded', 'account readable: the crawl just reserved now counts as a reservation');
update public.company_crawls set status = 'succeeded', cost_usd = 0.01, finished_at = now()
 where start_url like 'https://pgtap-fix-%' and status in ('pending', 'running');

-- account unreadable ----------------------------------------------------------
create temp table base3 as select public.lume_research_month_spend() as spend;
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c101', 'https://pgtap-fix-a.com/', 0.02, null,
     (select spend from base3) + 0.02 - 0.0001))->>'error',
  'budget_exceeded', 'account unreadable: falls back to our month-to-date sum (finished + reserved) + estimate, never $0');
select ok((select spend from base3) >= 5, 'the fallback sum includes the finished $5 run');
select is(
  (select r->>'basis' from (select public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c101', 'https://pgtap-fix-a.com/', 0.02, null,
     (select spend from base3) + 0.02) r) s),
  'ledger', 'account unreadable: exactly at the cap is accepted, basis ledger');
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c102', 'https://pgtap-fix-b.com/', 0.02, -1, 1000000))->>'basis',
  'ledger', 'a negative account figure is treated as unreadable');

-- stale sweep -----------------------------------------------------------------
update public.company_crawls set status = 'succeeded', finished_at = now() where start_url like 'https://pgtap-fix-%' and status in ('pending', 'running');
insert into public.company_crawls(id, company_id, status, start_url, estimate_usd, cost_usd, created_at) values
  ('00000000-0000-0000-0000-0000000cc201', '00000000-0000-0000-0000-00000000c101', 'running', 'https://pgtap-fix-a.com/', 0.02, 0.02, now() - interval '20 minutes'),
  ('00000000-0000-0000-0000-0000000cc202', '00000000-0000-0000-0000-00000000c102', 'pending', 'https://pgtap-fix-b.com/', 0.02, 0.02, now() - interval '16 minutes'),
  ('00000000-0000-0000-0000-0000000cc203', '00000000-0000-0000-0000-00000000c103', 'running', 'https://pgtap-fix-c.com/', 0.02, 0.02, now() - interval '5 minutes');
select ok(public.lume_research_fail_stale_crawls(15) >= 2, 'the sweep reports how many it failed');
select is(
  (select array_agg(status order by id) from public.company_crawls where id in
    ('00000000-0000-0000-0000-0000000cc201', '00000000-0000-0000-0000-0000000cc202', '00000000-0000-0000-0000-0000000cc203')),
  array['failed', 'failed', 'running'], 'running/pending older than 15 minutes -> failed; a fresh one is untouched');
select is(
  (select error from public.company_crawls where id = '00000000-0000-0000-0000-0000000cc201'),
  'stale: no result after 15 minutes', 'the failure says why');
select ok(
  (select finished_at is not null from public.company_crawls where id = '00000000-0000-0000-0000-0000000cc201'),
  'a swept crawl is finished');
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c101', 'https://pgtap-fix-a.com/', 0.02, 0, 1000000))->>'ok',
  'true', 'the swept company is free to crawl again');
select ok(
  not has_function_privilege('authenticated', 'public.lume_research_fail_stale_crawls(integer)', 'execute')
  and not has_function_privilege('anon', 'public.lume_research_fail_stale_crawls(integer)', 'execute')
  and not has_function_privilege('anon', 'public.lume_research_reserved_usd()', 'execute'),
  'the new functions are service role only');

select * from finish();
rollback;
