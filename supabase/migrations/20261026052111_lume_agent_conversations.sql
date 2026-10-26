-- Lume Agent tab: persistent chat history. Additive; writes are service role only.
create table if not exists agent_conversations (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default 'New chat',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists agent_conversations_recent_idx
  on agent_conversations (updated_at desc) where archived_at is null;

create table if not exists agent_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references agent_conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant')),
  text            text not null default '',
  tools           jsonb not null default '[]'::jsonb,
  approvals       jsonb not null default '[]'::jsonb,
  error           text,
  run_id          uuid references agent_runs(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists agent_messages_conversation_idx
  on agent_messages (conversation_id, created_at);

alter table agent_conversations enable row level security;
alter table agent_messages enable row level security;
revoke all on public.agent_conversations, public.agent_messages from anon, authenticated;
