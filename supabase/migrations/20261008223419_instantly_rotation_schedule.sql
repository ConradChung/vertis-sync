-- Applied 2026-10-08 via the Supabase MCP (version 20261008223419). Tracked here so the repo matches the DB.
-- Two rotate ticks a day. The bearer token is the project's anon JWT (publishable), which passes verify_jwt.
drop policy if exists lead_bank_anon_load on public.lead_bank;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
select cron.unschedule(jobid) from cron.job where jobname in ('instantly-rotate-am','instantly-rotate-pm');
select cron.schedule('instantly-rotate-am', '0 13 * * *', $$
  select net.http_post(
    url := 'https://rcfrumrbauwvyzfebxck.supabase.co/functions/v1/instantly-rotate?mode=rotate',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjZnJ1bXJiYXV3dnl6ZmVieGNrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5OTU2NzksImV4cCI6MjA4NzU3MTY3OX0.-ZDCDUbvsiuxGafkwD4fA6vCHGG4mT_ly-ScnF8nw7c"}'::jsonb,
    body := '{}'::jsonb, timeout_milliseconds := 300000);
$$);
select cron.schedule('instantly-rotate-pm', '0 1 * * *', $$
  select net.http_post(
    url := 'https://rcfrumrbauwvyzfebxck.supabase.co/functions/v1/instantly-rotate?mode=rotate',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjZnJ1bXJiYXV3dnl6ZmVieGNrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5OTU2NzksImV4cCI6MjA4NzU3MTY3OX0.-ZDCDUbvsiuxGafkwD4fA6vCHGG4mT_ly-ScnF8nw7c"}'::jsonb,
    body := '{}'::jsonb, timeout_milliseconds := 300000);
$$);
