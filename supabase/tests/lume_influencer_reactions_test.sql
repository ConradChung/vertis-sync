-- pgTAP: PM influencer reactions pipeline (migration lume_influencer_reactions).
--   tables are service-role only (RLS on, no anon/authenticated grants);
--   26 influencers seeded + the imported 2026-10-08 run;
--   one active run at a time;
--   lume_influencer_reserve_apify: shares the research budget (same cap,
--     reservations counted by lume_research_reserved_usd), never reserves the
--     same (run, influencer, kind) twice;
--   lume_influencer_merge_reactions: union merge, exactly once per Apify row,
--     new vs known reactors, generated counts;
--   lume_influencer_claim_run: lease + hand-off token;
--   lume_influencer_cancel_run / lume_influencer_sweep_stale;
--   pending_actions kinds influencer_run / influencer_reactions, one awaiting each.
-- Everything rolls back.
begin;
select plan(37);

-- security -------------------------------------------------------------------
select ok((select bool_and(relrowsecurity) from pg_class where relname in
  ('influencers', 'influencer_runs', 'influencer_apify_runs', 'influencer_posts', 'influencer_reactors', 'influencer_exports')
  and relnamespace = 'public'::regnamespace), 'RLS is on for every influencer table');
select ok(not has_table_privilege('anon', 'public.influencer_reactors', 'select'), 'anon cannot read reactors');
select ok(not has_table_privilege('authenticated', 'public.influencers', 'select'), 'authenticated cannot read influencers');
select ok(not has_function_privilege('anon', 'public.lume_influencer_reserve_apify(uuid, uuid, text, text, numeric, numeric, numeric)', 'execute'),
  'anon cannot call the budget gate');

-- seed -----------------------------------------------------------------------
select ok((select count(*) from public.influencers) >= 26, '26 influencers seeded');
select is((select last_leads from public.influencers where slug = 'peter-lohmann'), 71, 'Peter Lohmann: 71 leads last run');
select is((select last_leads_700 from public.influencers where slug = 'jay-parsons'), 24, 'Jay Parsons: 24 at 700+');
select ok((select bool_and(notes like 'Zero yield%') from public.influencers
  where slug in ('barbara-savona', 'dd-garzon', 'kristin-anikewich', 'angela-holman', 'david-rintz', 'mike-brewer')),
  'the six zero-yield influencers carry a note');
select is((select status from public.influencer_runs where id = '00000000-0000-4000-8000-000000001008'), 'imported', 'imported run exists');

-- one active run -------------------------------------------------------------
-- Any live run on the target DB would block the inserts below; clear it in this transaction only.
update public.influencer_runs set status = 'cancelled' where status in ('running', 'awaiting_approval');
insert into public.influencer_runs (id, influencer_ids, status)
  select '00000000-0000-4000-8000-0000000000a1', array[id], 'running' from public.influencers where slug = 'peter-lohmann';
select throws_ok(
  $$insert into public.influencer_runs (influencer_ids, status) select array[id], 'awaiting_approval' from public.influencers where slug = 'deb-newell'$$,
  '23505', null, 'a second active run is refused');

-- budget gate ----------------------------------------------------------------
create temp table base as select public.lume_research_reserved_usd() as reserved, public.lume_research_month_spend() as spend;

select is(
  (public.lume_influencer_reserve_apify('00000000-0000-4000-8000-0000000000a1',
     (select id from public.influencers where slug = 'peter-lohmann'), 'posts', 'harvestapi~linkedin-profile-posts',
     1.00, 10, 10 + (select reserved from base) + 1.00 - 0.0001))->>'error',
  'budget_exceeded', 'account + reservations + estimate over the cap is refused');
select is(
  (public.lume_influencer_reserve_apify('00000000-0000-4000-8000-0000000000a1',
     (select id from public.influencers where slug = 'peter-lohmann'), 'posts', 'harvestapi~linkedin-profile-posts',
     1.00, 10, 10 + (select reserved from base) + 1.00))->>'existing',
  'false', 'exactly at the cap is reserved');
select is(public.lume_research_reserved_usd(), (select reserved from base) + 1.00,
  'the influencer reservation counts in the shared research reserved_usd');
select is(public.lume_research_month_spend(), (select spend from base) + 1.00,
  'and in the ledger month spend');
select is(
  (public.lume_influencer_reserve_apify('00000000-0000-4000-8000-0000000000a1',
     (select id from public.influencers where slug = 'peter-lohmann'), 'posts', 'harvestapi~linkedin-profile-posts',
     1.00, 10, 1000))->>'existing',
  'true', 'the same (run, influencer, kind) is returned, never reserved twice');
select is((select count(*)::int from public.influencer_apify_runs where run_id = '00000000-0000-4000-8000-0000000000a1'), 1,
  'one Apify row');
select is(
  (public.lume_influencer_reserve_apify('00000000-0000-4000-8000-0000000000a1',
     (select id from public.influencers where slug = 'peter-lohmann'), 'reactions', 'harvestapi~linkedin-post-reactions',
     0.5, null, (select spend from base) + 1.00 + 0.5))->>'basis',
  'ledger', 'unreadable account usage falls back to the ledger (month spend + estimate, at the cap: reserved)');
-- a research crawl now sees the influencer reservation too
insert into public.companies(id, domain) values ('00000000-0000-0000-0000-00000000c901', 'pgtap-infl.com');
select is(
  (public.lume_research_reserve_crawl('00000000-0000-0000-0000-00000000c901', 'https://pgtap-infl.com/', 0.02, 0,
     (select reserved from base) + 1.00 + 0.02 - 0.0001))->>'error',
  'budget_exceeded', 'company-research''s gate counts the influencer reservation');

-- merge ----------------------------------------------------------------------
update public.influencer_apify_runs set status = 'succeeded', apify_run_id = 'runAAAAAAAA1'
 where run_id = '00000000-0000-4000-8000-0000000000a1' and kind = 'posts';
insert into public.influencer_reactors (linkedin_url, name, reacted_to, reacted_posts, first_seen_run, last_seen_run, triage, verdict)
  values ('https://www.linkedin.com/in/pgtap-known', 'Known', array['deb-newell'], array['p0'],
          '00000000-0000-4000-8000-000000001008', '00000000-0000-4000-8000-000000001008', 'likely', 'verified');
select is(
  public.lume_influencer_merge_reactions(
    (select id from public.influencer_apify_runs where run_id = '00000000-0000-4000-8000-0000000000a1' and kind = 'posts'),
    '[{"linkedin_url":"https://www.linkedin.com/in/pgtap-known","name":"Known","slug":"peter-lohmann","post_ids":["p1","p2"]},
      {"linkedin_url":"https://www.linkedin.com/in/pgtap-new","name":"New","headline":"Owner, Acme PM","slug":"peter-lohmann","post_ids":["p1"]},
      {"linkedin_url":"not a url","slug":"peter-lohmann","post_ids":["p1"]}]'::jsonb)->>'new_reactors',
  '1', 'one new reactor, one known; a row without a LinkedIn URL is skipped');
select is((select reacted_to from public.influencer_reactors where linkedin_url = 'https://www.linkedin.com/in/pgtap-known'),
  array['deb-newell', 'peter-lohmann'], 'reacted_to is the union of influencers');
select is((select influencer_count from public.influencer_reactors where linkedin_url = 'https://www.linkedin.com/in/pgtap-known'),
  2, 'influencer_count is generated');
select is((select reaction_count from public.influencer_reactors where linkedin_url = 'https://www.linkedin.com/in/pgtap-known'),
  3, 'reaction_count = distinct posts reacted to');
select is((select first_seen_run from public.influencer_reactors where linkedin_url = 'https://www.linkedin.com/in/pgtap-known'),
  '00000000-0000-4000-8000-000000001008'::uuid, 'a known reactor keeps its first_seen_run');
select is((select verdict from public.influencer_reactors where linkedin_url = 'https://www.linkedin.com/in/pgtap-known'),
  'verified', 'and its verdict');
select is(
  public.lume_influencer_merge_reactions(
    (select id from public.influencer_apify_runs where run_id = '00000000-0000-4000-8000-0000000000a1' and kind = 'posts'),
    '[{"linkedin_url":"https://www.linkedin.com/in/pgtap-new","slug":"peter-lohmann","post_ids":["p9"]}]'::jsonb)->>'already_ingested',
  'true', 'a dataset is merged exactly once');
select is((select reaction_count from public.influencer_reactors where linkedin_url = 'https://www.linkedin.com/in/pgtap-new'),
  1, 'the second merge changed nothing');

-- lease ----------------------------------------------------------------------
select is((select count(*)::int from public.lume_influencer_claim_run('00000000-0000-4000-8000-0000000000a1', null,
  '00000000-0000-4000-8000-00000000f001', 170)), 1, 'a free lease is claimed');
select is((select count(*)::int from public.lume_influencer_claim_run('00000000-0000-4000-8000-0000000000a1', null,
  '00000000-0000-4000-8000-00000000f002', 170)), 0, 'a live lease cannot be taken without the token');
select is((select count(*)::int from public.lume_influencer_claim_run('00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f003', 170)), 1, 'the hand-off token takes it over');
select is((select count(*)::int from public.lume_influencer_claim_run('00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f004', 170)), 0, 'a duplicate hand-off loses');

-- cancel ---------------------------------------------------------------------
update public.influencer_apify_runs set status = 'running', apify_run_id = 'runBBBBBBBB2'
 where run_id = '00000000-0000-4000-8000-0000000000a1' and kind = 'reactions';
select is((public.lume_influencer_cancel_run('00000000-0000-4000-8000-0000000000a1')->'abort'),
  '["runBBBBBBBB2"]'::jsonb, 'cancel returns the running Apify run ids to abort');
select is((select status from public.influencer_apify_runs where run_id = '00000000-0000-4000-8000-0000000000a1' and kind = 'reactions'),
  'aborted', 'a running Apify row of a cancelled run is aborted');
select is((public.lume_influencer_cancel_run('00000000-0000-4000-8000-0000000000a1'))->>'error', 'not_active', 'cancel twice: not_active');

-- stale sweep ----------------------------------------------------------------
insert into public.influencer_runs (id, influencer_ids, status, heartbeat_at, created_at)
  select '00000000-0000-4000-8000-0000000000a2', array[id], 'running', now() - interval '40 minutes', now() - interval '1 hour'
    from public.influencers where slug = 'peter-lohmann';
insert into public.influencer_apify_runs (run_id, influencer_id, kind, actor_id, status, apify_run_id)
  select '00000000-0000-4000-8000-0000000000a2', id, 'posts', 'a', 'running', 'runCCCCCCCC3' from public.influencers where slug = 'peter-lohmann';
select is((select array_agg(apify_run_id) from public.lume_influencer_sweep_stale(30)), array['runCCCCCCCC3'], 'stale sweep returns the Apify ids to abort');
select is((select status from public.influencer_runs where id = '00000000-0000-4000-8000-0000000000a2'), 'failed', 'the stale run is failed');

-- pending action kinds ---------------------------------------------------------
select lives_ok($$insert into public.pending_actions (kind, payload, requested_by)
  values ('influencer_reactions', '{"run_id":"r1","summary":"s"}', 'agent')$$, 'influencer_reactions is a valid kind');
select throws_ok($$insert into public.pending_actions (kind, payload, requested_by)
  values ('influencer_reactions', '{"run_id":"r1","summary":"s2"}', 'agent')$$, '23505', null, 'one awaiting reactions approval per run');

select * from finish();
rollback;
