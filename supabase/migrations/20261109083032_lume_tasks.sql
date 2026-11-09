-- Lume Calendar: scheduled tasks, mirrored to Linear issues (project "Lume").
-- A task is a reminder, or carries a requested pending action (action_kind +
-- action_payload, the request POST /api/actions takes). When it falls due the
-- rotation tick files that action as an AWAITING pending_action: the owner
-- still taps it (Telegram / Lume). Nothing here runs an action. Service role
-- only, like every lume_ table. Additive.
create table if not exists public.lume_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 200),
  notes text check (notes is null or length(notes) <= 4000),
  due_at timestamptz not null,
  all_day boolean not null default true,
  action_kind text,
  action_payload jsonb check (action_payload is null or jsonb_typeof(action_payload) = 'object'),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'awaiting_tap', 'running', 'done', 'failed', 'cancelled')),
  action_id uuid references public.pending_actions(id) on delete set null,
  last_error text check (last_error is null or length(last_error) <= 1000),
  reminded_at timestamptz,
  linear_issue_id text,
  linear_identifier text,
  linear_url text,
  linear_synced_at timestamptz,
  linear_error text check (linear_error is null or length(linear_error) <= 1000),
  created_by text not null default 'owner' check (created_by in ('owner', 'agent')),
  conversation_id uuid references public.agent_conversations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lume_tasks_action_check check ((action_kind is null) = (action_payload is null))
);
alter table public.lume_tasks enable row level security;
revoke all on public.lume_tasks from anon, authenticated;

create index if not exists lume_tasks_due_idx on public.lume_tasks (due_at);
create index if not exists lume_tasks_open_idx on public.lume_tasks (status, due_at)
  where status in ('scheduled', 'awaiting_tap', 'running');
create unique index if not exists lume_tasks_linear_issue_idx on public.lume_tasks (linear_issue_id)
  where linear_issue_id is not null;
