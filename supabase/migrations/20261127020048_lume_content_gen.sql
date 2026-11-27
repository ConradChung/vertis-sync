-- LinkedIn draft generator for Frank (Lume, lume/lib/content/).
-- Additive only: three new tables, one lume_settings row. Service role only.

-- ── facts bank: the only things a draft may state ─────────────────────────
create table if not exists public.content_facts (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('number','story','quote','offer','objection')),
  text        text not null check (length(btrim(text)) between 3 and 1000),
  source      text not null check (length(btrim(source)) between 3 and 300),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  retired_at  timestamptz
);
create unique index if not exists content_facts_text_uniq on public.content_facts (lower(btrim(text)));

-- ── drafts: every generated draft, accepted or rejected ───────────────────
create table if not exists public.content_drafts (
  id               bigint generated always as identity primary key,
  run_date         date not null,                       -- PT calendar day of the run
  slot             text not null check (slot in ('proof','owner_view','hand_raiser')),
  variant          text check (variant in ('breakdown','story')),
  status           text not null check (status in ('accepted','rejected','skipped','superseded','posted')),
  formula          text,
  body             text,
  first_comment    text,
  char_count       int,
  lead_fact_id     bigint references public.content_facts(id),
  fact_ids         bigint[] not null default '{}',
  reject_reason    text,
  attempts         int not null default 0,
  model            text,
  usd              numeric(10,4) not null default 0,
  dry_run          boolean not null default true,
  trigger          text not null default 'cron' check (trigger in ('cron','manual','redo')),
  redo_of          bigint references public.content_drafts(id),
  slack_team_id    text,
  slack_channel_id text,
  slack_ts         text,
  decided_by       text,
  decided_at       timestamptz,
  posted_post_id   text,
  posted_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists content_drafts_created on public.content_drafts (created_at desc);
create index if not exists content_drafts_lead on public.content_drafts (lead_fact_id, created_at desc);
create unique index if not exists content_drafts_post_uniq on public.content_drafts (posted_post_id) where posted_post_id is not null;

-- ── spend ledger: one row per Claude call ─────────────────────────────────
create table if not exists public.content_spend (
  id             bigint generated always as identity primary key,
  draft_id       bigint references public.content_drafts(id),
  model          text not null,
  usd            numeric(10,4) not null check (usd >= 0),
  input_tokens   int,
  output_tokens  int,
  created_at     timestamptz not null default now()
);
create index if not exists content_spend_time on public.content_spend (created_at);

alter table public.content_facts  enable row level security;
alter table public.content_drafts enable row level security;
alter table public.content_spend  enable row level security;
revoke all on public.content_facts, public.content_drafts, public.content_spend from anon, authenticated;

-- ── config: dry run on, nothing posts until the owner flips it ────────────
insert into public.lume_settings (key, value) values ('content_config', jsonb_build_object(
  'dry_run', true,
  'slack', jsonb_build_object('channel_name', 'content-gen', 'team_id', 'T082MHH6U5P'),
  'monthly_cap_usd', 5
)) on conflict (key) do nothing;

-- ── seed facts (exact words from the owner's brief) ───────────────────────
insert into public.content_facts (kind, text, source) values
  ('offer',  'Offer: a free week of Kaspen on the doors you pick; $9.50 per door per month after that, month to month, with setup done for you.', 'kaspen.ai, read 2026-11-27'),
  ('quote',  'Product: Kaspen is an AI property manager that works inside the software a team already uses (AppFolio, Buildium, Yardi and others), handling leasing, maintenance, resident messages, move-ins, delinquency, accounting and compliance by call, text and email, day and night.', 'kaspen.ai, read 2026-11-27'),
  ('number', 'Customer result: $98k saved in payroll costs, 350 units, Miami.', 'kaspen.ai, read 2026-11-27'),
  ('number', 'Customer result: 17 hours saved per manager every week, 1,000 units, Houston.', 'kaspen.ai, read 2026-11-27'),
  ('number', 'Customer result: 3x lead-to-lease, 850 units, Vancouver.', 'kaspen.ai, read 2026-11-27'),
  ('number', 'Reported averages from customers in 2026: reply to a new lead in under 2 minutes; maintenance resolved in 2.7 days on average; 99%+ of after-hours calls answered on the first ring.', 'kaspen.ai, read 2026-11-27'),
  ('number', 'Frank''s own firm: grew from 35 to 1,000 doors in 3 years.', 'from his LinkedIn posts, November 2026'),
  ('number', 'Frank''s own firm: after bringing AI into leasing, days on market went from 30+ to 19 and average units leased per agent rose 280%.', 'from his LinkedIn posts, November 2026'),
  ('story',  'Frank''s story: one call answered at 9:57 PM led to a 153-property deal; the firm moved from Monday-to-Friday 9-to-5 to operating 365 days a year.', 'from his LinkedIn posts, November 2026'),
  ('story',  'Frank''s story: an asset manager who owns 1,600 units in the Sun Belt told him his firm is considering cutting out its property management company and bringing management in-house to improve NOI.', 'from his LinkedIn posts, November 2026'),
  ('quote',  'Tagline: Grow doors, not payroll.', 'kaspen.ai, read 2026-11-27')
on conflict do nothing;
