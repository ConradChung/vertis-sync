-- PM influencer reactions: the sweep on a schedule (follows lume_influencer_reactions_fixes).
--
-- Until now lume_influencer_sweep() ran only when influencer-reactions was
-- invoked, so a dead hand-off chain kept its Apify rows (and their
-- reservations on the shared monthly cap) until the next start, approval or
-- cancel.
--
-- lume_influencer_sweep_tick(), every 5 minutes (pg_cron job influencer-sweep):
--   1. nothing live (no running / awaiting run, no pending / running Apify
--      row): returns without a request;
--   2. POSTs {action: 'sweep'} to the influencer-reactions edge function
--      (pg_net, with the vault entries project_url + service_role_key, the
--      same ones pipeline_watchdog and jobsearch_refill_tick use). The function
--      runs lume_influencer_sweep() and aborts the Apify runs it closed;
--   3. without those vault entries: lume_influencer_sweep() in SQL instead.
--      Rows it closes keep their Apify run id but are not aborted on Apify
--      from SQL (each run still stops at its maxTotalChargeUsd). Not done
--      when the request goes out: the SQL sweep would close rows under a
--      finished run before the function could abort them on Apify.
-- Never raises: a pg_net or lock hiccup must not fail the cron run.

create or replace function public.lume_influencer_sweep_tick() returns void
language plpgsql security definer
set search_path = pg_catalog, public
set lock_timeout = '2s'
as $$
declare
  key text;
  url text;
begin
  if not exists (select 1 from public.influencer_runs where status in ('running', 'awaiting_approval'))
     and not exists (select 1 from public.influencer_apify_runs where status in ('pending', 'running')) then
    return;
  end if;
  select decrypted_secret into key from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into url from vault.decrypted_secrets where name = 'project_url';
  if key is not null and url is not null then
    perform net.http_post(
      url     := url || '/functions/v1/influencer-reactions',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || key, 'apikey', key),
      body    := jsonb_build_object('action', 'sweep'));
  else
    perform 1 from public.lume_influencer_sweep();
  end if;
exception when others then
  raise warning 'lume_influencer_sweep_tick: %', sqlerrm;
end $$;
revoke all on function public.lume_influencer_sweep_tick() from public, anon, authenticated;

select cron.unschedule('influencer-sweep') where exists (
  select 1 from cron.job where jobname = 'influencer-sweep');
select cron.schedule('influencer-sweep', '*/5 * * * *', 'select public.lume_influencer_sweep_tick()');
