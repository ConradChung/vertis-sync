-- GTM-19 launch (apply ONLY after the owner approves, after the dry-run rows look right):
-- one pg_cron tick every 30 min → Lume /api/cron/hiring-signal (X-Lume-Hook-Secret).
-- The route decides what is due (hiring + expansion daily, new_manager weekly),
-- reads finished runs and processes new rows; lanes and caps live in
-- lume_settings.hiring_signal_config. Silent until vault lume_url + lume_hook_secret exist.

create or replace function public.lume_hiring_signal_tick()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare lurl text; hook text;
begin
  select decrypted_secret into lurl from vault.decrypted_secrets where name = 'lume_url';
  select decrypted_secret into hook from vault.decrypted_secrets where name = 'lume_hook_secret';
  if lurl is null or hook is null then return; end if;
  perform net.http_post(
    url     := lurl || '/api/cron/hiring-signal',
    headers := jsonb_build_object('Content-Type','application/json','X-Lume-Hook-Secret', hook),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000);
end $$;
revoke all on function public.lume_hiring_signal_tick() from public, anon, authenticated;

select cron.unschedule('lume-hiring-signal-tick') where exists (select 1 from cron.job where jobname = 'lume-hiring-signal-tick');
-- :15 and :45, off the signal tick's :05 / :35.
select cron.schedule('lume-hiring-signal-tick', '15,45 * * * *', 'select public.lume_hiring_signal_tick()');
