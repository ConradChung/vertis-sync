-- HELD (owner, 2026-11-22): do not apply until the owner has seen the dry-run cards.
-- Rename to the ledger version once applied.

-- GTM-14 launch: one pg_cron tick every 30 min.
--   1. signal-comments edge fn (service role) — polls, filters, ingests reactor runs.
--   2. Lume /api/cron/signal-alerts (X-Lume-Hook-Secret) — posts ready cards / digests / notices
--      (dry_run in signal_config keeps it from posting).
--   3. Lume /api/cron/signal-reactions — files the Monday one-tap reactions card when due.
-- Applied only after the owner approves going live; the dry run invokes these by hand.

create or replace function public.lume_signal_tick()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare key text; proj text; lurl text; hook text;
begin
  select decrypted_secret into key  from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into proj from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into lurl from vault.decrypted_secrets where name = 'lume_url';
  select decrypted_secret into hook from vault.decrypted_secrets where name = 'lume_hook_secret';
  if key is not null and proj is not null then
    perform net.http_post(
      url     := proj || '/functions/v1/signal-comments',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || key,'apikey', key),
      body    := jsonb_build_object('action','tick'),
      timeout_milliseconds := 150000);
  end if;
  if lurl is not null and hook is not null then
    perform net.http_post(
      url     := lurl || '/api/cron/signal-alerts',
      headers := jsonb_build_object('Content-Type','application/json','X-Lume-Hook-Secret', hook),
      body    := '{}'::jsonb);
    perform net.http_post(
      url     := lurl || '/api/cron/signal-reactions',
      headers := jsonb_build_object('Content-Type','application/json','X-Lume-Hook-Secret', hook),
      body    := '{}'::jsonb);
  end if;
end $$;
revoke all on function public.lume_signal_tick() from public, anon, authenticated;

select cron.unschedule('lume-signal-tick') where exists (select 1 from cron.job where jobname = 'lume-signal-tick');
-- :05 and :35 so the alerts call sees what the previous tick finished.
select cron.schedule('lume-signal-tick', '5,35 * * * *', 'select public.lume_signal_tick()');
