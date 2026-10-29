-- Lume agent projects: no orphaned uploads, and a typed bucket.
--
-- 1. agent_project_uploads: one row per signed upload, written when the
--    upload is signed and removed when it is finalized (or rejected). A
--    browser that signs and never finalizes leaves a row; the hourly sweep
--    deletes the object and the row once it is an hour old. No fk to the
--    project on purpose: a deleted project's pending uploads still get swept.
-- 2. lume_project_upload_sweep(): POSTs /api/cron/project-uploads (the same
--    pg_net + X-Lume-Hook-Secret pattern as lume_rotation_tick) only when a
--    row is over an hour old. Objects are deleted through the Storage API in
--    the route: Supabase does not allow deleting storage.objects from SQL.
-- 3. The agent-projects bucket accepts only the types Lume supports.
create table if not exists agent_project_uploads (
  storage_path text primary key,
  project_id   uuid not null,
  created_at   timestamptz not null default now()
);
create index if not exists agent_project_uploads_created_idx on agent_project_uploads (created_at);
alter table agent_project_uploads enable row level security;
revoke all on public.agent_project_uploads from anon, authenticated;

create or replace function public.lume_project_upload_sweep() returns void
language plpgsql security definer
set search_path = pg_catalog, public
set lock_timeout = '1s'
as $$
declare
  url text; secret text;
begin
  if not exists (select 1 from agent_project_uploads where created_at < now() - interval '1 hour') then
    return;
  end if;
  select decrypted_secret into url from vault.decrypted_secrets where name = 'lume_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'lume_hook_secret';
  if url is null or secret is null then return; end if;
  perform net.http_post(
    url     := url || '/api/cron/project-uploads',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Lume-Hook-Secret', secret),
    body    := '{}'::jsonb);
end $$;
revoke all on function public.lume_project_upload_sweep() from public, anon, authenticated;

select cron.unschedule('lume-project-upload-sweep') where exists (
  select 1 from cron.job where jobname = 'lume-project-upload-sweep');
select cron.schedule('lume-project-upload-sweep', '17 * * * *', 'select public.lume_project_upload_sweep()');

update storage.buckets
   set allowed_mime_types = array[
     'text/csv', 'application/pdf', 'text/plain', 'text/markdown', 'application/json',
     'image/png', 'image/jpeg', 'image/gif', 'image/webp'
   ]
 where id = 'agent-projects';
