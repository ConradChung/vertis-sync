-- Lume: review and filter scraped leads in the Agent chat before a manual Apollo export.
create table if not exists lead_review_sets (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_kind text not null check (source_kind in ('dataset', 'run', 'job')),
  source_id text not null,
  source_conversation_id uuid references agent_conversations(id) on delete set null,
  item_count integer not null default 0,
  filters jsonb not null default '[]'::jsonb check (jsonb_typeof(filters) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists lead_review_sets_conversation_idx on lead_review_sets (source_conversation_id, created_at desc) where archived_at is null;

create table if not exists lead_review_items (
  id bigserial primary key,
  set_id uuid not null references lead_review_sets(id) on delete cascade,
  idx integer not null,
  item jsonb not null,
  raw jsonb,
  status text not null default 'kept' check (status in ('kept', 'excluded')),
  excluded_reason text,
  filter_id text,
  created_at timestamptz not null default now(),
  unique (set_id, idx)
);
create index if not exists lead_review_items_set_status_idx on lead_review_items (set_id, status, idx);

alter table lead_review_sets enable row level security;
alter table lead_review_items enable row level security;
revoke all on public.lead_review_sets from anon, authenticated;
revoke all on public.lead_review_items from anon, authenticated;
revoke all on sequence public.lead_review_items_id_seq from anon, authenticated;
