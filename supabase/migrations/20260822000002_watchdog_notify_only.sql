-- The watchdog used to revive stalled jobs by itself. That went wrong twice:
-- it revived an abandoned April job and burned MailTester credits on a list
-- nobody was waiting for, and its "same done-count across two ticks" heuristic
-- could not tell a stalled job from a slow one. It now asks the owner instead.
--
-- Detection moved into the pipeline-watchdog edge function. Doing it here would
-- have meant copying TELEGRAM_BOT_TOKEN into the vault to send the message, and
-- a secret that already exists as an edge function env var should not be
-- duplicated into the database. pg_cron now only triggers; the function decides.

create or replace function public.pipeline_watchdog() returns void
language plpgsql security definer as $$
declare
  key text;
  url text;
begin
  select decrypted_secret into key from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into url from vault.decrypted_secrets where name = 'project_url';
  if key is null or url is null then return; end if;

  perform net.http_post(
    url     := url || '/functions/v1/pipeline-watchdog',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || key,
                 'apikey', key
               ),
    body    := '{}'::jsonb
  );
end $$;

-- pipeline_watchdog_state supported the old two-sample heuristic and is no
-- longer read. Kept rather than dropped so rolling back to the previous
-- function definition still finds its table.
comment on table pipeline_watchdog_state is
  'Unused since 2026-08-22. Superseded by validation_jobs.watchdog_status / watchdog_notified_at.';
