-- pgTAP: the 5-minute influencer sweep (migration lume_influencer_sweep_cron).
--   the cron job exists; the tick is not callable by anon/authenticated;
--   nothing live -> no request; a live run -> one POST {action: 'sweep'} to
--   influencer-reactions (queued in pg_net, rolled back here, never sent).
-- Everything rolls back.
begin;
select plan(7);

select is((select schedule from cron.job where jobname = 'influencer-sweep'), '*/5 * * * *', 'influencer-sweep runs every 5 minutes');
select ok(not has_function_privilege('anon', 'public.lume_influencer_sweep_tick()', 'execute'), 'anon cannot run the tick');
select ok(not has_function_privilege('authenticated', 'public.lume_influencer_sweep_tick()', 'execute'), 'authenticated cannot run the tick');

update public.influencer_runs set status = 'cancelled' where status in ('running', 'awaiting_approval');
update public.influencer_apify_runs set status = 'failed' where status in ('pending', 'running');
create temp table q0 as select count(*) as n from net.http_request_queue;
select public.lume_influencer_sweep_tick();
select is((select count(*) from net.http_request_queue), (select n from q0), 'nothing live: no request');

insert into public.influencer_runs (id, influencer_ids, status)
  select '00000000-0000-4000-8000-0000000000c1', array[id], 'running' from public.influencers where slug = 'peter-lohmann';
select public.lume_influencer_sweep_tick();
select is((select count(*) from net.http_request_queue), (select n from q0) + 1, 'a live run: one request');
select ok((select url from net.http_request_queue order by id desc limit 1) like '%/functions/v1/influencer-reactions', 'to influencer-reactions');
select is((select convert_from(body, 'utf8')::jsonb from net.http_request_queue order by id desc limit 1), '{"action":"sweep"}'::jsonb, 'the sweep action');

select * from finish();
rollback;
