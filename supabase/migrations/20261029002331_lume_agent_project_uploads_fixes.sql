-- Signed upload URLs stay valid for 2 hours, so an agent_project_uploads row
-- younger than that may still get its object: lume_project_upload_sweep()
-- only POSTs once a row is over 3 hours old (/api/cron/project-uploads uses
-- the same 3 h). Same signature, owner, search_path, lock_timeout and grants
-- as 20261029001255_lume_agent_project_uploads.sql.
create or replace function public.lume_project_upload_sweep() returns void
language plpgsql security definer
set search_path = pg_catalog, public
set lock_timeout = '1s'
as $$
declare
  url text; secret text;
begin
  if not exists (select 1 from agent_project_uploads where created_at < now() - interval '3 hours') then
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
