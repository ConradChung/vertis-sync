-- GTM-14 · Frank's post commenters (+ weekly reactors) → PM filter → #sales.
--
-- Comments lane: standing approval (owner, 2026-11-22) under its own caps
--   (Apify $10 / cycle, filter $5 / cycle, $1 / PT day across the lane).
-- Reactions lane: Monday one-tap card through the existing influencer
--   single-post pipeline; this schema only tracks which posts were filed.
-- Cards are built by the edge fn and posted by Lume (/api/cron/signal-alerts).
-- The cron schedule ships in a separate migration at launch (dry run first).

-- ── Posts ────────────────────────────────────────────────────────────────
create table if not exists public.signal_posts (
  post_id               text primary key,                 -- LinkedIn activity id (digits)
  source                text not null default 'frank',
  post_url              text not null,
  posted_at             timestamptz not null,
  first_seen_at         timestamptz not null default now(),
  text_excerpt          text,
  likes                 int,
  comment_count         int not null default 0,           -- last observed
  comments_pulled_at_count int not null default 0,        -- comment_count when comments were last pulled
  last_count_check_at   timestamptz,
  last_comments_pull_at timestamptz,
  reactions_status      text not null default 'pending'
    check (reactions_status in ('pending','filed','running','done','skipped','held')),
  reactions_action_id   uuid,
  reactions_run_id      uuid,
  reactions_note        text,
  digest_status         text check (digest_status in ('ready','dry_run','posted','empty')),
  digest_card           jsonb,
  digest_slack_ts       text,
  digest_posted_at      timestamptz,
  updated_at            timestamptz not null default now()
);
create index if not exists signal_posts_posted_at on public.signal_posts (posted_at desc);

-- ── People (commenters and reactors; one row per LinkedIn person) ────────
create table if not exists public.signal_people (
  id                    bigserial primary key,
  linkedin_id           text unique,                      -- preferred key
  linkedin_url          text not null unique,             -- normalized https://www.linkedin.com/in/<slug>
  name                  text,
  first_name            text,
  headline              text,
  company_guess         text,                             -- from the Haiku headline pass; handed to Perplexity
  kind                  text not null check (kind in ('commenter','reactor')),  -- commenter wins
  post_id               text references public.signal_posts(post_id),
  comment_text          text,
  comment_url           text,
  commented_at          timestamptz,
  reactor_run_id        uuid,                             -- influencer_runs.id for reactors
  stage                 text not null default 'new'
    check (stage in ('new','triage','verify','crawl','doors','contacts','draft','ready','alerted','skipped','error')),
  skip_reason           text,                             -- known_in_lume | already_alerted | exported | triage_no | not_pm | not_decision_maker | vendor | unreachable | no_website | cap_stopped
  attempts              int not null default 0,
  last_error            text,
  triage                text check (triage in ('likely','possible','no')),
  company_name          text,
  company_website       text,
  title                 text,
  location              text,
  is_decision_maker     boolean,
  crawl_verdict         text,
  crawl_reason          text,
  doors_hint            text,                             -- crawl worker free text; numeric count → door_count, Perplexity doors skipped
  door_count            int,
  door_count_source     text,
  door_count_confidence text check (door_count_confidence in ('high','medium','low')),
  contacts              jsonb,                            -- [{name,title,linkedin_url}] ≤3
  connected             boolean,                          -- null = unknown (no Connections.csv)
  drafts                jsonb,                            -- {opening, dm, connection_note, followup_dm, no_note_followup}
  card                  jsonb,                            -- Slack blocks as built (dry run shows these)
  alert_status          text check (alert_status in ('dry_run','posted','approved','edited','skipped')),
  slack_team_id         text,
  slack_channel_id      text,
  slack_ts              text,
  decided_by            text,
  decided_at            timestamptz,
  spend_usd             numeric(10,4) not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists signal_people_stage on public.signal_people (stage) where stage not in ('alerted','skipped');
create index if not exists signal_people_post on public.signal_people (post_id);

-- ── Spend ledger (caps are read from here) ───────────────────────────────
-- lane: comments_apify | comments_filter | reactions_apify
-- Apify rows are written as a reservation (status 'reserved', usd = maxTotalChargeUsd)
-- and settled to the actual cost when the run finishes.
create table if not exists public.signal_spend (
  id            bigserial primary key,
  lane          text not null check (lane in ('comments_apify','comments_filter','reactions_apify')),
  kind          text not null,                            -- posts_48h | posts_7d | comments | haiku | perplexity | doors | apollo | reactions
  status        text not null default 'settled' check (status in ('reserved','settled','released')),
  usd           numeric(10,4) not null check (usd >= 0),
  apify_run_id  text,
  dataset_id    text,
  post_id       text,
  person_id     bigint,
  created_at    timestamptz not null default now(),
  settled_at    timestamptz
);
create index if not exists signal_spend_lane_time on public.signal_spend (lane, created_at);
create unique index if not exists signal_spend_apify_run on public.signal_spend (apify_run_id) where apify_run_id is not null;

-- ── Once-only notices to #sales (cap warnings, lane stops) ───────────────
create table if not exists public.signal_notices (
  key        text primary key,                            -- e.g. 'warn80:comments_apify:2026-11-24', 'stop:daily:2026-11-23'
  text       text not null,
  status     text not null default 'pending' check (status in ('pending','dry_run','posted')),
  created_at timestamptz not null default now(),
  posted_at  timestamptz
);

-- ── Lane state (one row) ─────────────────────────────────────────────────
create table if not exists public.signal_state (
  id                  int primary key default 1 check (id = 1),
  last_posts_7d_at    timestamptz,
  last_posts_48h_at   timestamptz,
  first_run_at        timestamptz,                        -- set on the first tick; posts older than 7 d before it are ignored
  stopped_at          timestamptz,                        -- set when a cap stops the comments lane
  stopped_reason      text,
  lease_until         timestamptz,                        -- one tick at a time
  lease_token         uuid,
  updated_at          timestamptz not null default now()
);
insert into public.signal_state (id) values (1) on conflict do nothing;

-- ── Settings (owner-editable; read by edge fn and Lume) ──────────────────
insert into public.lume_settings (key, value) values ('signal_config', jsonb_build_object(
  'dry_run', true,
  'profile_url', 'https://www.linkedin.com/in/frank22/',
  'slack', jsonb_build_object('team_id', null, 'channel_id', null, 'channel_name', 'sales'),
  'caps', jsonb_build_object(
    'comments_apify_usd', 10,
    'comments_filter_usd', 5,
    'comments_daily_usd', 1,
    'reactions_apify_usd', 8,
    'reactions_per_post', 200,
    'warn_at', 0.8),
  'reactor_opening', null
)) on conflict (key) do nothing;

-- ── RLS: service role / definer only (same as other lume_* tables) ──────
alter table public.signal_posts   enable row level security;
alter table public.signal_people  enable row level security;
alter table public.signal_spend   enable row level security;
alter table public.signal_notices enable row level security;
alter table public.signal_state   enable row level security;
revoke all on public.signal_posts, public.signal_people, public.signal_spend,
              public.signal_notices, public.signal_state from anon, authenticated;
revoke all on sequence public.signal_people_id_seq, public.signal_spend_id_seq from anon, authenticated;

-- ── Lease (one tick at a time) ───────────────────────────────────────────
create or replace function public.signal_claim_tick(p_token uuid, p_seconds int default 240)
returns boolean language sql security definer set search_path = public as $$
  update signal_state set lease_token = p_token, lease_until = now() + make_interval(secs => p_seconds), updated_at = now()
   where id = 1 and (lease_until is null or lease_until < now())
  returning true;
$$;
revoke all on function public.signal_claim_tick(uuid, int) from public, anon, authenticated;

-- ── Lane spend in a window (reserved + settled; released rows excluded) ──
create or replace function public.signal_lane_spend(p_lanes text[], p_since timestamptz)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(usd), 0) from signal_spend
   where lane = any(p_lanes) and status <> 'released' and created_at >= p_since;
$$;
revoke all on function public.signal_lane_spend(text[], timestamptz) from public, anon, authenticated;
