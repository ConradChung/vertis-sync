-- Lume Agent chat: images pasted / attached to a message. Additive.
-- References live on the message (no base64 in rows); bytes live in a private
-- bucket that only the service role touches (no storage.objects policies, so
-- anon / authenticated get nothing). Uploads go through POST /api/agent/images,
-- which sniffs the magic bytes before storing.
alter table public.agent_messages
  add column if not exists attachments jsonb not null default '[]'::jsonb;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('agent-chat-images', 'agent-chat-images', false, 2097152,
        array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do nothing;
