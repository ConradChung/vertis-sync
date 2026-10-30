-- pgTAP: research core (migration lume_research_core,
-- docs/lume/2026-10-29-research-signals-design.md P1):
--   companies (normalized unique domain), lead_bank.company_id,
--   company_crawls (+ one active crawl per company, the budget reserve RPC),
--   company_facts (field list, confidence enum, source URL required),
--   signals (dedupe key, expiry default + index), jurisdictions,
--   lead_personalization_log. Service role only. Everything rolls back.
begin;
select plan(43);

-- companies ------------------------------------------------------------------
select has_table('public', 'companies', 'companies exists');
select lives_ok(
  $$insert into public.companies(id, domain, name) values ('00000000-0000-0000-0000-00000000c001', 'pgtap-acme.com', 'Acme PM')$$,
  'a normalized domain is accepted');
select throws_ok(
  $$insert into public.companies(domain) values ('pgtap-acme.com')$$,
  '23505', null, 'the domain is unique');
select throws_ok($$insert into public.companies(domain) values ('PGTAP-Upper.com')$$, '23514', null, 'upper case is refused');
select throws_ok($$insert into public.companies(domain) values ('www.pgtap-www.com')$$, '23514', null, 'a www. prefix is refused');
select throws_ok($$insert into public.companies(domain) values ('https://pgtap-scheme.com')$$, '23514', null, 'a scheme is refused');
select throws_ok($$insert into public.companies(domain) values ('pgtap-path.com/about')$$, '23514', null, 'a path is refused');
select throws_ok($$insert into public.companies(domain) values ('localhost')$$, '23514', null, 'a dotless host is refused');

-- lead_bank.company_id -------------------------------------------------------
select has_column('public', 'lead_bank', 'company_id', 'lead_bank.company_id exists');
select col_is_null('public', 'lead_bank', 'company_id', 'lead_bank.company_id is nullable (no backfill)');
select fk_ok('public', 'lead_bank', 'company_id', 'public', 'companies', 'id', 'lead_bank.company_id references companies');

-- company_crawls + reserve ----------------------------------------------------
select has_table('public', 'company_crawls', 'company_crawls exists');
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c001', 'https://pgtap-acme.com/', 0.02, 1000000, 1000000.01))->>'ok',
  'false', 'reserve refuses when account usage + month-to-date + estimate would cross the cap');
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c001', 'https://pgtap-acme.com/', 0.02, 1000000, 1000000.01))->>'error',
  'budget_exceeded', 'crossing the cap is budget_exceeded');
select is(
  (select count(*)::int from public.company_crawls where company_id = '00000000-0000-0000-0000-00000000c001'),
  0, 'a refused reserve writes nothing');
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c001', 'https://pgtap-acme.com/', 0.02, 0, 1000000))->>'ok',
  'true', 'a reserve under the cap is accepted');
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c001', 'https://pgtap-acme.com/', 0.02, 1000000 - 0.02 - public.lume_research_reserved_usd(), 1000000))->>'error',
  'crawl_in_progress', 'landing exactly on the cap passes the budget (refused here only because a crawl is active)');
select is(
  (select cost_usd from public.company_crawls where company_id = '00000000-0000-0000-0000-00000000c001'),
  0.02::numeric, 'the reserved row carries the estimate as its cost until the actual is recorded');
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c001', 'https://pgtap-acme.com/', 0.02, 0, 1000000))->>'error',
  'crawl_in_progress', 'one active crawl per company');
select throws_ok(
  $$insert into public.company_crawls(company_id, status, start_url) values ('00000000-0000-0000-0000-00000000c001', 'done', 'https://x.com/')$$,
  '23514', null, 'status is a known value');
select throws_ok(
  $$insert into public.company_crawls(company_id, status, start_url, cost_usd) values ('00000000-0000-0000-0000-00000000c001', 'failed', 'https://x.com/', -1)$$,
  '23514', null, 'cost is never negative');
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c001', 'https://pgtap-acme.com/', -0.01, 0, 1000000))->>'error',
  'bad_estimate', 'a negative estimate is refused');
select is(
  (public.lume_research_month_spend()),
  (select coalesce(sum(cost_usd), 0) from public.company_crawls where created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'),
  'month spend is the sum of this calendar month''s crawl costs (UTC)');

-- company_facts --------------------------------------------------------------
select has_table('public', 'company_facts', 'company_facts exists');
select lives_ok(
  $$insert into public.company_facts(company_id, field, value, copy_value, confidence, source_url, snippet)
    values ('00000000-0000-0000-0000-00000000c001', 'door_count', '1237', '1200', 'high', 'https://pgtap-acme.com/about', 'we manage 1,237 doors')$$,
  'a fact with a source is accepted');
select lives_ok(
  $$insert into public.company_facts(company_id, field, value, confidence, source_url, snippet)
    values ('00000000-0000-0000-0000-00000000c001', 'door_count', '1300', 'high', 'https://pgtap-acme.com/about', 'we manage 1,300 doors')$$,
  'history is kept (a second value for the same field)');
select throws_ok(
  $$insert into public.company_facts(company_id, field, value, confidence, source_url, snippet)
    values ('00000000-0000-0000-0000-00000000c001', 'door_count', '1', 'certain', 'https://x.com/', 's')$$,
  '23514', null, 'confidence is high|medium|low');
select throws_ok(
  $$insert into public.company_facts(company_id, field, value, confidence, source_url, snippet)
    values ('00000000-0000-0000-0000-00000000c001', 'favourite_colour', '"blue"', 'high', 'https://x.com/', 's')$$,
  '23514', null, 'field is one of the known fields');
select throws_ok(
  $$insert into public.company_facts(company_id, field, value, confidence, snippet)
    values ('00000000-0000-0000-0000-00000000c001', 'city', '"Vancouver"', 'high', 'Vancouver')$$,
  '23502', null, 'every fact needs a source URL');
select throws_ok(
  $$insert into public.company_facts(company_id, field, value, confidence, source_url, snippet)
    values ('00000000-0000-0000-0000-00000000c001', 'city', '"Vancouver"', 'high', 'ftp://x.com/', 'Vancouver')$$,
  '23514', null, 'the source URL is http(s)');

-- signals --------------------------------------------------------------------
select has_table('public', 'signals', 'signals exists');
select lives_ok(
  $$insert into public.signals(company_id, signal_type, detail, source_url, dedupe_key)
    values ('00000000-0000-0000-0000-00000000c001', 'open_role', '{"title":"Maintenance Coordinator"}', 'https://pgtap-acme.com/careers', 'maintenance-coordinator')$$,
  'a signal is accepted');
select throws_ok(
  $$insert into public.signals(company_id, signal_type, detail, source_url, dedupe_key)
    values ('00000000-0000-0000-0000-00000000c001', 'open_role', '{}', 'https://pgtap-acme.com/careers', 'maintenance-coordinator')$$,
  '23505', null, 'the same signal is recorded once (dedupe key)');
select lives_ok(
  $$insert into public.signals(company_id, signal_type, detail, source_url, dedupe_key)
    values ('00000000-0000-0000-0000-00000000c001', 'open_role', '{"title":"Leasing Agent"}', 'https://pgtap-acme.com/careers', 'leasing-agent')$$,
  'several open roles per company: the key includes the normalized role title (dedupe_key)');
select is(
  (select (expires_at - detected_at) from public.signals where dedupe_key = 'maintenance-coordinator'),
  interval '30 days', 'a signal expires 30 days after detection by default');
select throws_ok(
  $$insert into public.signals(company_id, signal_type, detail, source_url, dedupe_key)
    values ('00000000-0000-0000-0000-00000000c001', 'review_spike', '{}', 'https://x.com/', 'k')$$,
  '23514', null, 'signal_type is a known type (no review signals)');
select ok(
  exists(select 1 from pg_indexes where tablename = 'signals' and indexdef like '%(expires_at)%'),
  'signals(expires_at) is indexed');

-- jurisdictions + personalization log ---------------------------------------
select has_table('public', 'jurisdictions', 'jurisdictions exists');
select is((select count(*)::int from public.jurisdictions where active), 0, 'no jurisdiction ships active (P4 seeds them inactive)');
select has_table('public', 'lead_personalization_log', 'lead_personalization_log exists');

-- service role only ----------------------------------------------------------
select ok(
  (select bool_and(relrowsecurity) from pg_class
    where oid in ('public.companies'::regclass, 'public.company_facts'::regclass, 'public.company_crawls'::regclass,
                  'public.signals'::regclass, 'public.jurisdictions'::regclass, 'public.lead_personalization_log'::regclass)),
  'RLS is on for every research table');
select ok(
  not exists(
    select 1 from unnest(array['companies','company_facts','company_crawls','signals','jurisdictions','lead_personalization_log']) t
     where has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')),
  'no direct read for anon or authenticated');
select ok(
  not has_function_privilege('authenticated', 'public.lume_research_reserve_crawl(uuid, text, numeric, numeric, numeric)', 'execute')
  and not has_function_privilege('anon', 'public.lume_research_reserve_crawl(uuid, text, numeric, numeric, numeric)', 'execute'),
  'the reserve RPC is service role only');

select * from finish();
rollback;
