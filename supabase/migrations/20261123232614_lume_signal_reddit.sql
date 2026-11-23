-- GTM-15: Reddit mentions of AppFolio / Buildium (F5Bot alerts) → #sales.
-- Additive only. One row per Reddit post or comment, unique on its canonical
-- permalink, so the same alert forwarded twice makes one card. Lume (service
-- role) is the only reader/writer; anon and authenticated get nothing.

create table if not exists public.signal_reddit_mentions (
  id               bigint generated always as identity primary key,
  permalink        text not null unique,          -- canonical key: https://www.reddit.com/r/<sub>/comments/<id>/_/[<comment>/] (lowercase)
  url              text not null,                 -- the link as found (with its slug), for Open thread
  kind             text not null check (kind in ('post', 'comment')),
  subreddit        text,
  author           text,                          -- Reddit handle, null when Reddit's JSON could not be read
  title            text,                          -- the thread title
  snippet          text,                          -- the post or comment text, clipped
  keyword          text,                          -- appfolio / buildium / … (what matched)
  hot              boolean not null default false, -- complaint or switching language
  reddit_created_at timestamptz,
  fetch_error      text,
  email_message_id text,
  alert_status     text check (alert_status in ('dry_run', 'posted', 'contacted', 'skipped')),
  card             jsonb,
  slack_team_id    text,
  slack_channel_id text,
  slack_ts         text,
  decided_by       text,
  decided_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists signal_reddit_mentions_unalerted on public.signal_reddit_mentions (id) where alert_status is null;

alter table public.signal_reddit_mentions enable row level security;
revoke all on public.signal_reddit_mentions from anon, authenticated;
revoke all on sequence public.signal_reddit_mentions_id_seq from anon, authenticated;
