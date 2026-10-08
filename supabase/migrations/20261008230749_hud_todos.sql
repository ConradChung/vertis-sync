-- Applied 2026-10-08 via the Supabase MCP (version 20261008230749). Tracked here so the repo matches the DB.
-- Shared to-do list for the Lead Rotation HUD (github.com/ConradChung/lead-rotation-hud). Any signed-in CRM user can read and write; anon gets nothing.
create table if not exists public.hud_todos (
  id bigserial primary key,
  title text not null,
  notes text,
  status text not null default 'todo' check (status in ('todo','doing','done')),
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  pipeline text check (pipeline in ('apify','supabase','instantly','sendpilot','clay','general')),
  due_at timestamptz,
  position int not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists hud_todos_status_idx on public.hud_todos (status, position, id);
alter table public.hud_todos enable row level security;
drop policy if exists hud_todos_authenticated_all on public.hud_todos;
create policy hud_todos_authenticated_all on public.hud_todos for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.hud_todos to authenticated;
grant usage, select on sequence public.hud_todos_id_seq to authenticated;
create or replace function public.hud_todos_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists hud_todos_touch on public.hud_todos;
create trigger hud_todos_touch before update on public.hud_todos for each row execute function public.hud_todos_touch();
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'hud_todos') then
    alter publication supabase_realtime add table public.hud_todos;
  end if;
end $$;
-- Seed rows (the open items from the 2026-10-08 build) were inserted at apply time and are not repeated here.
