-- Lume Agent: saved pipelines ("skills") the owner can re-run or attach as reference. Additive; service role only.
create table if not exists agent_skills (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null check (length(btrim(name)) between 1 and 80),
  description            text not null default '',
  steps                  jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array'),
  variables              jsonb not null default '[]'::jsonb check (jsonb_typeof(variables) = 'array'),
  source_conversation_id uuid references agent_conversations(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  last_run_at            timestamptz,
  run_count              integer not null default 0 check (run_count >= 0),
  archived_at            timestamptz
);
create unique index if not exists agent_skills_name_live_idx
  on agent_skills (lower(btrim(name))) where archived_at is null;
create index if not exists agent_skills_recent_idx
  on agent_skills (updated_at desc) where archived_at is null;

-- Atomic run counter (Run button / run_skill context).
create or replace function agent_skill_mark_run(p_id uuid)
returns void language sql security invoker set search_path = public as $$
  update agent_skills set run_count = run_count + 1, last_run_at = now()
  where id = p_id and archived_at is null;
$$;

alter table agent_skills enable row level security;
revoke all on public.agent_skills from anon, authenticated;
revoke all on function public.agent_skill_mark_run(uuid) from public, anon, authenticated;
grant execute on function public.agent_skill_mark_run(uuid) to service_role;
