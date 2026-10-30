-- Review fixes for chat spreadsheet attachments. Additive.
-- 1. Bucket limit ~11 MB (sources are ≤ 10 MB; the gzipped parsed copy is
--    refused past the same limit).
update storage.buckets set file_size_limit = 11534336 where id = 'agent-chat-files';

-- 2. A file belongs to the chat it was first sent in (null = uploaded, not sent
--    yet). /api/agent/run binds it on send and refuses another chat's file.
alter table public.agent_chat_files
  add column if not exists conversation_id uuid references public.agent_conversations(id) on delete set null;
create index if not exists agent_chat_files_conversation_idx on public.agent_chat_files (conversation_id);

-- 3. The short form replayed in later turns: name, sheets with counts, headers (no rows).
alter table public.agent_chat_files
  add column if not exists brief text not null default '' check (char_length(brief) <= 8000);

-- 4. One row per signed upload (like agent_project_uploads). Finalize claims
--    it with a conditional update (claimed_at is null → now()), so a second
--    concurrent finalize gets 409 and never touches the first one's objects.
--    Rows over 3 hours old (signed upload URLs live 2 h) are swept by
--    /api/cron/project-uploads: objects of a file that never got a row are
--    deleted through the Storage API (SQL may not delete storage.objects).
create table if not exists public.agent_chat_file_uploads (
  storage_path text primary key,
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz
);
create index if not exists agent_chat_file_uploads_created_idx on public.agent_chat_file_uploads (created_at);
alter table public.agent_chat_file_uploads enable row level security;
revoke all on public.agent_chat_file_uploads from anon, authenticated;

-- 5. The hourly sweep also fires for stale chat-file uploads. Same signature,
--    owner, search_path, lock_timeout and grants as before.
create or replace function public.lume_project_upload_sweep() returns void
language plpgsql security definer
set search_path = pg_catalog, public
set lock_timeout = '1s'
as $$
declare
  url text; secret text;
begin
  if not exists (select 1 from agent_project_uploads where created_at < now() - interval '3 hours')
     and not exists (select 1 from agent_chat_file_uploads where created_at < now() - interval '3 hours') then
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
