-- Lume reply desk + LinkedIn ICP gate (additive).
--
-- A. ICP gate: signal_people may wait at stage 'held' (units unknown) until the
--    owner types a count in Signals; signal_config gains an `icp` key
--    { min_units 500, owner_operator_only true, unknown_units 'hold' } when missing.
-- B/C. Reply desk: SendPilot's LinkedIn reply notifications from one Slack
--    channel (raw first), Claude's extraction and label, drafted answers in the
--    Slack thread, the follow-up schedule and Claude spend ($10/month cap in
--    reply_desk_config). LinkedIn deals carry their profile URL and no
--    placeholder address: crm_deals.email may be null when linkedin_url is set.
--    Every new table is service-role only. Nothing is ever sent on LinkedIn.

-- ── A. signal_people 'held' ─────────────────────────────────────────────────
alter table public.signal_people drop constraint if exists signal_people_stage_check;
alter table public.signal_people add constraint signal_people_stage_check
  check (stage in ('new','triage','verify','crawl','doors','contacts','draft','ready','alerted','skipped','error','held'));

update public.lume_settings
   set value = value || jsonb_build_object('icp', jsonb_build_object('min_units', 500, 'owner_operator_only', true, 'unknown_units', 'hold')),
       updated_at = now()
 where key = 'signal_config' and not (value ? 'icp');

-- ── crm_deals: LinkedIn deals ───────────────────────────────────────────────
alter table public.crm_deals add column if not exists linkedin_url text
  check (linkedin_url is null or (length(linkedin_url) <= 300 and linkedin_url ~ '^https://www\.linkedin\.com/in/'));
alter table public.crm_deals alter column email drop not null;
alter table public.crm_deals add constraint crm_deals_email_or_linkedin check (email is not null or linkedin_url is not null);
create unique index if not exists crm_deals_campaign_linkedin_key on public.crm_deals (campaign_id, linkedin_url) where linkedin_url is not null;

-- ── reply desk tables ───────────────────────────────────────────────────────
create table if not exists public.reply_desk_inbound (
  id            bigint generated always as identity primary key,
  team_id       text not null check (team_id ~ '^[TE][A-Z0-9]{2,30}$'),
  channel_id    text not null check (channel_id ~ '^[CG][A-Z0-9]{2,30}$'),
  ts            text not null check (ts ~ '^[0-9]+\.[0-9]+$'),
  raw           jsonb not null,
  status        text not null default 'saved' check (status in ('saved','extracted','failed')),
  extraction    jsonb,
  label         text check (label in ('interested','question','not_now','not_interested','other')),
  person_name   text check (person_name is null or length(person_name) <= 200),
  company       text check (company is null or length(company) <= 200),
  linkedin_url  text check (linkedin_url is null or length(linkedin_url) <= 300),
  message       text check (message is null or length(message) <= 4000),
  check_back_on date,
  deal_id       uuid references public.crm_deals(id) on delete set null,
  error         text check (error is null or length(error) <= 500),
  received_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (channel_id, ts)
);
create index if not exists reply_desk_inbound_deal_idx on public.reply_desk_inbound (deal_id, received_at desc);

create table if not exists public.reply_desk_threads (
  deal_id        uuid primary key references public.crm_deals(id) on delete cascade,
  team_id        text not null,
  channel_id     text not null,
  thread_ts      text not null check (thread_ts ~ '^[0-9]+\.[0-9]+$'),
  inbound_id     bigint references public.reply_desk_inbound(id) on delete set null,
  last_label     text check (last_label in ('interested','question','not_now','not_interested','other')),
  schedule       text check (schedule in ('followup','checkin')),
  anchor_at      timestamptz,
  next_step      int not null default 0 check (next_step between 0 and 20),
  next_due_at    timestamptz,
  stopped_reason text check (stopped_reason is null or length(stopped_reason) <= 80),
  last_sent_at   timestamptz,
  updated_at     timestamptz not null default now()
);
create index if not exists reply_desk_threads_due_idx on public.reply_desk_threads (next_due_at) where schedule is not null;

create table if not exists public.reply_desk_drafts (
  id          bigint generated always as identity primary key,
  deal_id     uuid not null references public.crm_deals(id) on delete cascade,
  inbound_id  bigint references public.reply_desk_inbound(id) on delete set null,
  kind        text not null check (kind in ('reply','followup','checkin')),
  step        int check (step is null or step between 0 and 20),
  macro       text check (macro is null or length(macro) <= 40),
  reason      text check (reason is null or length(reason) <= 200),
  body        text not null check (length(btrim(body)) between 1 and 3000),
  status      text not null default 'posted' check (status in ('posted','sent','redone','booked','not_interested','superseded','failed')),
  team_id     text not null,
  channel_id  text not null,
  thread_ts   text not null,
  slack_ts    text,
  model       text,
  usd         numeric(10,4) not null default 0,
  decided_at  timestamptz,
  decided_by  text check (decided_by is null or decided_by ~ '^[UW][A-Z0-9]{2,30}$'),
  created_at  timestamptz not null default now()
);
create index if not exists reply_desk_drafts_deal_idx on public.reply_desk_drafts (deal_id, id);
create index if not exists reply_desk_drafts_inbound_idx on public.reply_desk_drafts (inbound_id);

create table if not exists public.reply_desk_spend (
  id            bigint generated always as identity primary key,
  kind          text not null check (kind in ('extract','draft')),
  model         text not null,
  usd           numeric(10,4) not null check (usd >= 0),
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  inbound_id    bigint references public.reply_desk_inbound(id) on delete set null,
  draft_id      bigint references public.reply_desk_drafts(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists reply_desk_spend_created_idx on public.reply_desk_spend (created_at);

alter table public.reply_desk_inbound enable row level security;
alter table public.reply_desk_threads enable row level security;
alter table public.reply_desk_drafts  enable row level security;
alter table public.reply_desk_spend   enable row level security;
revoke all on public.reply_desk_inbound from anon, authenticated;
revoke all on public.reply_desk_threads from anon, authenticated;
revoke all on public.reply_desk_drafts  from anon, authenticated;
revoke all on public.reply_desk_spend   from anon, authenticated;

-- ── config: no channel until the owner sets one in Settings → Slack ─────────
insert into public.lume_settings (key, value) values ('reply_desk_config', jsonb_build_object(
  'slack', jsonb_build_object('team_id', null, 'channel_id', null, 'channel_name', null),
  'monthly_cap_usd', 10,
  'followup_days', jsonb_build_array(2, 5, 9, 14, 21),
  'checkin_days', 30
)) on conflict (key) do nothing;

-- ── follow-up tick: every 15 minutes; the route posts only weekdays 8 AM-6 PM PT ──
create or replace function public.lume_reply_desk_tick()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare lurl text; hook text;
begin
  -- Nothing to do (no schedule due): no HTTP call at all.
  if not exists (select 1 from public.reply_desk_threads where schedule is not null and next_due_at <= now()) then return; end if;
  select decrypted_secret into lurl from vault.decrypted_secrets where name = 'lume_url';
  select decrypted_secret into hook from vault.decrypted_secrets where name = 'lume_hook_secret';
  if lurl is null or hook is null then return; end if;
  perform net.http_post(
    url     := lurl || '/api/cron/reply-desk',
    headers := jsonb_build_object('Content-Type','application/json','X-Lume-Hook-Secret', hook),
    body    := '{}'::jsonb,
    timeout_milliseconds := 300000);
end $$;
revoke all on function public.lume_reply_desk_tick() from public, anon, authenticated;

select cron.unschedule('lume-reply-desk-tick') where exists (select 1 from cron.job where jobname = 'lume-reply-desk-tick');
select cron.schedule('lume-reply-desk-tick', '*/15 * * * *', 'select public.lume_reply_desk_tick()');
