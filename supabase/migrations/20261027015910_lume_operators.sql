-- Grok Bot operator layer (Phase G1): verticals, operator keys, attribution.
-- Service role only, like the other Lume tables written after the owner guard.
create table if not exists lume_verticals (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique check (length(btrim(name)) > 0),
  campaign_ids text[] not null default '{}',
  scopes       text[] not null default '{}'
               check (scopes <@ array['campaign','orders','replies','validation']::text[]),
  is_default   boolean not null default false,
  created_at   timestamptz not null default now(),
  archived_at  timestamptz
);
-- At most one default vertical: it receives items no vertical claims.
create unique index if not exists lume_verticals_one_default_idx on lume_verticals (is_default) where is_default;

create table if not exists lume_operators (
  id           uuid primary key default gen_random_uuid(),
  vertical_id  uuid references lume_verticals(id),
  is_master    boolean not null default false,
  label        text not null,
  key_hash     text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  last_seen_at timestamptz,
  -- The master bot is tied to no vertical; every other bot to exactly one.
  constraint lume_operators_master_check check (is_master = (vertical_id is null))
);
create index if not exists lume_operators_vertical_idx on lume_operators (vertical_id);

alter table lume_verticals enable row level security;
alter table lume_operators enable row level security;
revoke all on public.lume_verticals, public.lume_operators from anon, authenticated;

-- Attribution: a decision made by a Grok Bot operator.
alter table pending_actions drop constraint if exists pending_actions_decided_via_check;
alter table pending_actions add constraint pending_actions_decided_via_check
  check (decided_via in ('lume','telegram','agent','operator'));
alter table pending_actions add column if not exists decided_by_operator uuid references lume_operators(id);

-- Agent chats a bot starts carry its vertical and operator.
alter table agent_conversations add column if not exists vertical_id uuid references lume_verticals(id);
alter table agent_conversations add column if not exists operator_id uuid references lume_operators(id);
