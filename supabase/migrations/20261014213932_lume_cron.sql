-- supabase/migrations/20261014213932_lume_cron.sql
-- Lume: the cron side. Three pg_cron jobs and the function behind the first.
--
-- 1. lume-rotation-tick (every 15 min): asks Lume to evaluate due rotation
--    rules. Notify-only, same shape as pipeline_watchdog(): the tick POSTs an
--    empty body to lume_url/api/cron/rotation-tick and Lume decides what, if
--    anything, to push. It never touches lead_bank. Until the owner creates the
--    lume_url and lume_hook_secret vault entries it returns silently, and it
--    also returns without posting when no active rule is due, so an idle Lume
--    costs nothing.
-- 2. lume-events-purge (04:30 UTC): events older than 90 days. Load-bearing
--    for PII, not just table size: lume_event_on_change() stores the whole
--    source row under payload.row (lead emails, Apollo URLs, filenames), so
--    this retention is the only thing bounding how long those copies live.
-- 3. cron-history-prune (03:00 UTC): cron.job_run_details older than 30 days.
--    pg_cron never cleans that table (PK only; 18.7k rows at the time of
--    writing, ~300/day from the 5-minute watchdog alone) and
--    lume_scheduled_jobs() is now its first reader, a correlated scan per job.
--
-- Also re-creates lume_is_owner() with search_path = pg_catalog, public: it was
-- the last lume function with public first. Same body and grants as
-- 20261014103940_lume_core_fixes.sql; the policies keep its OID.
--
-- Each job is unscheduled first if it exists, so the file is re-runnable
-- without relying on cron.schedule's handling of a duplicate jobname.
--
-- OWNER SETUP (one-time, run as the project owner; values never in the repo):
--   select vault.create_secret('https://<lume host>', 'lume_url');
--   select vault.create_secret('<random 32 bytes>', 'lume_hook_secret');

-- 1. rotation tick -----------------------------------------------------------
create or replace function public.lume_rotation_tick() returns void
language plpgsql security definer
set search_path = pg_catalog, public
set lock_timeout = '1s'
as $$
declare
  url text; secret text;
begin
  select decrypted_secret into url from vault.decrypted_secrets where name = 'lume_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'lume_hook_secret';
  if url is null or secret is null then return; end if;
  if not exists (select 1 from rotation_rules
                 where active and (next_run_at is null or next_run_at <= now())) then
    return;
  end if;
  perform net.http_post(
    url     := url || '/api/cron/rotation-tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Lume-Hook-Secret', secret),
    body    := '{}'::jsonb);
exception when others then
  -- a pg_net hiccup or a locked rotation_rules must never fail the cron run
  raise warning 'lume_rotation_tick: %', sqlerrm;
end $$;
revoke all on function public.lume_rotation_tick() from public, anon, authenticated;

select cron.unschedule('lume-rotation-tick') where exists (
  select 1 from cron.job where jobname = 'lume-rotation-tick');
select cron.schedule('lume-rotation-tick', '*/15 * * * *', 'select public.lume_rotation_tick()');

-- 2. events retention --------------------------------------------------------
-- PII, not housekeeping: payload.row is a full copy of the pipeline row that
-- changed (lead email, Apollo URL, filename). 90 days is as long as those
-- copies may outlive the row they were taken from.
select cron.unschedule('lume-events-purge') where exists (
  select 1 from cron.job where jobname = 'lume-events-purge');
select cron.schedule('lume-events-purge', '30 4 * * *',
  $$delete from public.events where created_at < now() - interval '90 days'$$);

-- 3. pg_cron history ---------------------------------------------------------
-- cron.job_run_details only ever grows (pg_cron keeps every run, PK only) and
-- lume_scheduled_jobs() reads it per job; 30 days is more history than the
-- dashboard shows. Rows still running (end_time null) are untouched.
select cron.unschedule('cron-history-prune') where exists (
  select 1 from cron.job where jobname = 'cron-history-prune');
select cron.schedule('cron-history-prune', '0 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '30 days'$$);

-- 4. lume_is_owner(): catalog-first search_path, same body and grants --------
create or replace function public.lume_is_owner() returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(
    (select lower(auth.jwt() ->> 'email') = lower(decrypted_secret)
       from vault.decrypted_secrets where name = 'lume_owner_email' limit 1),
    false)
$$;
revoke all on function public.lume_is_owner() from public, anon;
grant execute on function public.lume_is_owner() to authenticated, service_role;
