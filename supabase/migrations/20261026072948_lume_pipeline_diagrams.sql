-- Lume Playground: pipeline diagrams saved from Agent chats. Additive; service role only.
create table if not exists pipeline_diagrams (
  id                     uuid primary key default gen_random_uuid(),
  title                  text not null check (length(btrim(title)) between 1 and 120),
  spec                   jsonb not null check (jsonb_typeof(spec) = 'object'),
  spec_hash              text not null,
  source_conversation_id uuid references agent_conversations(id) on delete set null,
  source_message_id      uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  archived_at            timestamptz
);
-- One live row per identical spec, so "Open in Playground" twice reuses it.
create unique index if not exists pipeline_diagrams_hash_live_idx
  on pipeline_diagrams (spec_hash) where archived_at is null;
create index if not exists pipeline_diagrams_recent_idx
  on pipeline_diagrams (updated_at desc) where archived_at is null;

alter table pipeline_diagrams enable row level security;
revoke all on public.pipeline_diagrams from anon, authenticated;
grant all on public.pipeline_diagrams to service_role;
