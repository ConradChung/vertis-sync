-- Inbox manager 3g: the client Slack app (docs/lume/2026-10-28-inbox-manager-design.md,
-- "Client Slack agent"; owner steps in docs/lume/SLACK-CLIENT-SETUP.md).
--
-- 1. lume_slack_installs: one row per client Slack workspace that installed
--    Lume through OAuth. The bot token is stored ENCRYPTED by the app
--    (AES-256-GCM, key LUME_SLACK_TOKEN_KEY, the team id as associated data;
--    lume/lib/slack/crypto.ts): the database never sees it in plaintext.
--    revoked_at is set by an app_uninstalled / tokens_revoked event or the
--    owner's Revoke; a re-install clears it with a new token.
-- 2. lume_slack_channels: a channel bound to one vertical and, optionally, a
--    subset of its campaigns (empty = all of the vertical's campaigns), with
--    the lead-card fields this client may see.
-- 3. lume_slack_posts: one Slack post per (reply, workspace, channel); the
--    unique key is the dedupe (the row is claimed before chat.postMessage).
--    `card` keeps the lead facts the post was built from, so updates never
--    re-read them.
-- 4. pending_actions gains decided_by_slack_user / decided_by_slack_team: who
--    approved or skipped in Slack (decided_via 'client' requires both).
-- All three tables: RLS on, no policies, service role only.

create table public.lume_slack_installs (
  team_id text primary key check (team_id ~ '^[TE][A-Z0-9]{2,30}$'),
  team_name text check (team_name is null or length(team_name) <= 200),
  bot_user_id text not null check (bot_user_id ~ '^[UWB][A-Z0-9]{2,30}$'),
  bot_token_enc text not null check (bot_token_enc ~ '^v1:[A-Za-z0-9_-]+$' and length(bot_token_enc) <= 2000),
  scopes text check (scopes is null or length(scopes) <= 500),
  installed_by text check (installed_by is null or installed_by ~ '^[UW][A-Z0-9]{2,30}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table public.lume_slack_installs enable row level security;
revoke all on public.lume_slack_installs from anon, authenticated;

create table public.lume_slack_channels (
  id uuid primary key default gen_random_uuid(),
  team_id text not null references public.lume_slack_installs(team_id) on delete cascade,
  channel_id text not null check (channel_id ~ '^[CGD][A-Z0-9]{2,30}$'),
  channel_name text check (channel_name is null or length(channel_name) <= 200),
  vertical_id uuid not null references public.lume_verticals(id) on delete cascade,
  campaign_ids text[] not null default '{}' check (cardinality(campaign_ids) <= 100),
  visible_fields text[] not null default array['name', 'title', 'company', 'website', 'phone', 'linkedin', 'location', 'reply', 'stage']
    check (visible_fields <@ array['name', 'title', 'company', 'website', 'phone', 'linkedin', 'location', 'reply', 'stage']),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, channel_id)
);
alter table public.lume_slack_channels enable row level security;
revoke all on public.lume_slack_channels from anon, authenticated;

create table public.lume_slack_posts (
  id bigint generated always as identity primary key,
  reply_to_uuid text not null check (length(reply_to_uuid) between 1 and 200),
  team_id text not null references public.lume_slack_installs(team_id) on delete cascade,
  channel_id text not null check (channel_id ~ '^[CGD][A-Z0-9]{2,30}$'),
  ts text check (ts is null or ts ~ '^[0-9]+\.[0-9]+$'),
  action_id uuid references public.pending_actions(id) on delete set null,
  card jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reply_to_uuid, team_id, channel_id)
);
create index lume_slack_posts_ts_idx on public.lume_slack_posts (team_id, channel_id, ts);
alter table public.lume_slack_posts enable row level security;
revoke all on public.lume_slack_posts from anon, authenticated;

alter table public.pending_actions
  add column decided_by_slack_user text check (decided_by_slack_user is null or decided_by_slack_user ~ '^[UW][A-Z0-9]{2,30}$'),
  add column decided_by_slack_team text check (decided_by_slack_team is null or decided_by_slack_team ~ '^[TE][A-Z0-9]{2,30}$');
alter table public.pending_actions add constraint pending_actions_client_decider_check
  check (decided_via is distinct from 'client' or (decided_by_slack_user is not null and decided_by_slack_team is not null));
