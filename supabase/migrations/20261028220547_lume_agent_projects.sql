-- Lume Agent tab: projects. A project is a folder of agent conversations plus
-- knowledge (instructions, files, notes) the agent sees in every chat filed in
-- it, optionally linked to one vertical. Additive; service role only.
create table if not exists agent_projects (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(btrim(name)) between 1 and 80),
  instructions text not null default '' check (length(instructions) <= 8000),
  vertical_id  uuid references lume_verticals(id) on delete set null,
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  archived_at  timestamptz
);
-- Names are unique among live projects (case-insensitive).
create unique index if not exists agent_projects_name_live_idx
  on agent_projects (lower(btrim(name))) where archived_at is null;
-- A vertical links to at most one live project.
create unique index if not exists agent_projects_vertical_live_idx
  on agent_projects (vertical_id) where archived_at is null and vertical_id is not null;
create index if not exists agent_projects_position_idx
  on agent_projects (position) where archived_at is null;

create table if not exists agent_project_files (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references agent_projects(id) on delete cascade,
  kind         text not null check (kind in ('file', 'note')),
  name         text not null check (length(btrim(name)) between 1 and 255),
  mime         text,
  size_bytes   bigint not null default 0 check (size_bytes between 0 and 20971520),
  storage_path text unique,
  -- Extracted text (CSV header + first 200 rows; PDF text layer; MD/TXT/JSON as-is), capped.
  text_content text check (text_content is null or length(text_content) <= 200000),
  -- False: stored, but no text could be extracted ("not readable"); images are listed by name only.
  readable     boolean not null default true,
  -- The extracted text was cut at a cap (row or character).
  truncated    boolean not null default false,
  created_at   timestamptz not null default now(),
  constraint agent_project_files_path_check check ((kind = 'note') = (storage_path is null))
);
create index if not exists agent_project_files_project_idx
  on agent_project_files (project_id, created_at desc);

-- null = Unfiled. Deleting a project moves its chats back to Unfiled.
alter table agent_conversations add column if not exists project_id uuid references agent_projects(id) on delete set null;
create index if not exists agent_conversations_project_idx
  on agent_conversations (project_id) where archived_at is null;

alter table agent_projects enable row level security;
alter table agent_project_files enable row level security;
revoke all on public.agent_projects, public.agent_project_files from anon, authenticated;

-- Private bucket for project files (the browser uploads to a signed URL; reads are service role).
insert into storage.buckets (id, name, public, file_size_limit)
values ('agent-projects', 'agent-projects', false, 20971520)
on conflict (id) do nothing;
