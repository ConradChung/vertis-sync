-- Lume: durable things the agent learned across chats (clients, ICPs, preferences, decisions).
create table if not exists agent_memory (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('preference', 'fact', 'client', 'decision')),
  content text not null check (char_length(btrim(content)) between 1 and 500),
  source_conversation_id uuid references agent_conversations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists agent_memory_recent_idx on agent_memory (updated_at desc) where archived_at is null;
create unique index if not exists agent_memory_content_live_idx on agent_memory (lower(btrim(content))) where archived_at is null;

alter table agent_memory enable row level security;
revoke all on public.agent_memory from anon, authenticated;
