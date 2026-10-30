-- pgTAP: PM influencer reactions money-safety fixes (migration lume_influencer_reactions_fixes).
--   reserve refuses unless the run is running (cancel stops new starts mid-step);
--   lume_influencer_fail_run closes the run and its live Apify rows (ids to abort);
--   lume_influencer_sweep: rows under a terminal run, a pending row with no run
--   id after 5 min, a running row after 30 min, a run past 6 h, a reactions
--   approval waiting 72 h; reservations are released.
-- Everything rolls back.
begin;
select plan(16);

update public.influencer_runs set status = 'cancelled' where status in ('running', 'awaiting_approval');
create temp table ids as select
  (select id from public.influencers where slug = 'peter-lohmann') as peter,
  (select id from public.influencers where slug = 'deb-newell') as deb,
  '00000000-0000-4000-8000-0000000000b1'::uuid as run,
  public.lume_research_reserved_usd() as r0;
insert into public.influencer_runs (id, influencer_ids, status) select run, array[peter, deb], 'running' from ids;

select is((select public.lume_influencer_reserve_apify(run, peter, 'reactions', 'a', 1, 0, 1000)->>'ok' from ids), 'true', 'reserve while running');
update public.influencer_apify_runs set status = 'running', apify_run_id = 'runDDDDDDDD4', started_at = now() where run_id = (select run from ids);
update public.influencer_runs set status = 'cancelled' where id = (select run from ids);
select is((select public.lume_influencer_reserve_apify(run, deb, 'reactions', 'a', 1, 0, 1000)->>'error' from ids), 'run_not_running',
  'a cancelled run reserves nothing more, even in the middle of a step');
select is((select count(*)::int from public.influencer_apify_runs where run_id = (select run from ids)), 1, 'no new Apify row after cancel');
select is((select array_agg(s.apify_run_id) from public.lume_influencer_sweep() s where s.run_id = (select run from ids)), array['runDDDDDDDD4'],
  'the sweep closes a live row under a terminal run and returns it to abort');

update public.influencer_runs set status = 'running' where id = (select run from ids);
insert into public.influencer_apify_runs (run_id, influencer_id, kind, actor_id, status, apify_run_id, estimate_usd, cost_usd)
  select run, deb, 'reactions', 'a', 'running', 'runEEEEEEEE5', 2, 2 from ids;
select ok(public.lume_research_reserved_usd() >= (select r0 from ids) + 2, 'a live row is reserved');
select is((select public.lume_influencer_fail_run(run, 'boom')->'abort' from ids), '["runEEEEEEEE5"]'::jsonb, 'fail_run returns the live Apify runs to abort');
select is((select status from public.influencer_runs where id = (select run from ids)), 'failed', 'fail_run fails the run');
select is((select count(*)::int from public.influencer_apify_runs where run_id = (select run from ids) and status in ('pending', 'running')), 0,
  'a failed run leaves no live Apify rows');
update public.influencer_apify_runs set finished_at = now() - interval '11 minutes' where run_id = (select run from ids);
select is(public.lume_research_reserved_usd(), (select r0 from ids), 'its reservation is released after the 10-minute lag window');

delete from public.influencer_apify_runs where run_id = (select run from ids);
update public.influencer_runs set status = 'running', approved_at = now() - interval '1 hour', heartbeat_at = now(), finished_at = null where id = (select run from ids);
insert into public.influencer_apify_runs (run_id, influencer_id, kind, actor_id, status, created_at) select run, peter, 'posts', 'a', 'pending', now() - interval '6 minutes' from ids;
insert into public.influencer_apify_runs (run_id, influencer_id, kind, actor_id, status, apify_run_id, started_at) select run, deb, 'posts', 'a', 'running', 'runFFFFFFFF6', now() - interval '31 minutes' from ids;
insert into public.influencer_apify_runs (run_id, influencer_id, kind, actor_id, status, apify_run_id, started_at) select run, peter, 'reactions', 'a', 'running', 'runGGGGGGGG7', now() - interval '2 minutes' from ids;
select is((select count(*)::int from public.lume_influencer_sweep() s where s.run_id = (select run from ids)), 2,
  'a pending row with no run id after 5 min and a running row after 30 min are closed');
select is((select status from public.influencer_apify_runs where run_id = (select run from ids) and kind = 'reactions'), 'running', 'a young running row is kept');
select is((select status from public.influencer_runs where id = (select run from ids)), 'running', 'the run itself is kept');
update public.influencer_runs set approved_at = now() - interval '7 hours' where id = (select run from ids);
select is((select array_agg(s.apify_run_id) from public.lume_influencer_sweep() s where s.run_id = (select run from ids)), array['runGGGGGGGG7'],
  'past the max run age the run fails and its live rows close');
select is((select status from public.influencer_runs where id = (select run from ids)), 'failed', 'max run age fails the run');
update public.influencer_runs set status = 'awaiting_approval', awaiting_since = now() - interval '73 hours', finished_at = null where id = (select run from ids);
select lives_ok('select count(*) from public.lume_influencer_sweep()', 'sweep runs');
select is((select status from public.influencer_runs where id = (select run from ids)), 'cancelled', 'an unapproved reactions bill expires after 72 h');

select * from finish();
rollback;
