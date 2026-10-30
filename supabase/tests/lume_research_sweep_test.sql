-- pgTAP: research stale sweep with run ids (migration lume_research_sweep_fixes):
--   lume_research_sweep_stale_crawls(minutes) fails pending/running crawls older
--   than that and returns (id, apify_run_id) so the caller can abort the Apify
--   runs; lume_research_fail_stale_crawls(minutes) stays as the count.
-- Everything rolls back.
begin;
select plan(7);

insert into public.companies(id, domain) values
  ('00000000-0000-0000-0000-00000000c301', 'pgtap-sweep-a.com'),
  ('00000000-0000-0000-0000-00000000c302', 'pgtap-sweep-b.com'),
  ('00000000-0000-0000-0000-00000000c303', 'pgtap-sweep-c.com'),
  ('00000000-0000-0000-0000-00000000c304', 'pgtap-sweep-d.com');
insert into public.company_crawls(id, company_id, status, start_url, apify_run_id, created_at) values
  ('00000000-0000-0000-0000-0000000cc301', '00000000-0000-0000-0000-00000000c301', 'running', 'https://pgtap-sweep-a.com/', 'pgtap-run-a', now() - interval '20 minutes'),
  ('00000000-0000-0000-0000-0000000cc302', '00000000-0000-0000-0000-00000000c302', 'pending', 'https://pgtap-sweep-b.com/', 'pgtap-run-b', now() - interval '16 minutes'),
  ('00000000-0000-0000-0000-0000000cc303', '00000000-0000-0000-0000-00000000c303', 'pending', 'https://pgtap-sweep-c.com/', null, now() - interval '30 minutes'),
  ('00000000-0000-0000-0000-0000000cc304', '00000000-0000-0000-0000-00000000c304', 'running', 'https://pgtap-sweep-d.com/', 'pgtap-run-d', now() - interval '5 minutes');

create temp table swept as select * from public.lume_research_sweep_stale_crawls(15);

select ok(
  (select count(*) from swept where id in ('00000000-0000-0000-0000-0000000cc301', '00000000-0000-0000-0000-0000000cc302', '00000000-0000-0000-0000-0000000cc303')) = 3,
  'stale running and pending crawls are swept (with or without a run id)');
select is(
  (select array_agg(apify_run_id order by id) from swept where id::text like '00000000-0000-0000-0000-0000000cc3%'),
  array['pgtap-run-a', 'pgtap-run-b', null], 'each swept crawl comes back with its run id (a pending one with a run id included)');
select ok(not exists(select 1 from swept where id = '00000000-0000-0000-0000-0000000cc304'), 'a fresh crawl is not swept');
select is(
  (select array_agg(status order by id) from public.company_crawls where id::text like '00000000-0000-0000-0000-0000000cc3%'),
  array['failed', 'failed', 'failed', 'running'], 'swept crawls are failed');
select is(
  (select count(*)::int from public.lume_research_sweep_stale_crawls(15) where id::text like '00000000-0000-0000-0000-0000000cc3%'),
  0, 'a second sweep finds nothing new');
update public.company_crawls set created_at = now() - interval '40 minutes' where id = '00000000-0000-0000-0000-0000000cc304';
select ok(public.lume_research_fail_stale_crawls(15) >= 1, 'lume_research_fail_stale_crawls still returns the count');
select ok(
  not has_function_privilege('authenticated', 'public.lume_research_sweep_stale_crawls(integer)', 'execute')
  and not has_function_privilege('anon', 'public.lume_research_sweep_stale_crawls(integer)', 'execute'),
  'the sweep is service role only');

select * from finish();
rollback;
