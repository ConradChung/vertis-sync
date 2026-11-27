-- LinkedIn draft generator schedule: Tue / Wed / Thu at 6:30 AM Pacific.
-- pg_cron runs in UTC, so it fires at 13:30 (PDT) and 14:30 (PST) UTC; the
-- Lume route writes a draft only on the call that lands in the 6 AM PT hour
-- and only once per day. dry_run in lume_settings.content_config still decides
-- whether anything reaches Slack. Nothing is posted to LinkedIn, ever.
create or replace function public.lume_content_gen_tick()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare lurl text; hook text;
begin
  select decrypted_secret into lurl from vault.decrypted_secrets where name = 'lume_url';
  select decrypted_secret into hook from vault.decrypted_secrets where name = 'lume_hook_secret';
  if lurl is null or hook is null then return; end if;
  perform net.http_post(
    url     := lurl || '/api/cron/content-gen',
    headers := jsonb_build_object('Content-Type','application/json','X-Lume-Hook-Secret', hook),
    body    := '{}'::jsonb,
    timeout_milliseconds := 300000);
end $$;
revoke all on function public.lume_content_gen_tick() from public, anon, authenticated;

select cron.unschedule('lume-content-gen-tick') where exists (select 1 from cron.job where jobname = 'lume-content-gen-tick');
select cron.schedule('lume-content-gen-tick', '30 13,14 * * 2-4', 'select public.lume_content_gen_tick()');
