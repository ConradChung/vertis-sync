-- LinkedIn draft generator: why each failed try was rejected, kept on accepted drafts too.
alter table public.content_drafts add column if not exists attempt_log jsonb not null default '[]'::jsonb;
