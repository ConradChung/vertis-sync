-- Lume 90-day plan, phase 2: the path to a paying customer in the CRM.
-- Four stages after the existing ones (Conversation, Demo, Pilot, Paid),
-- pilot tracking on the deal (start date, the day-10 and day-25 check-ins,
-- whether a referral was asked for) and the weekly scoreboard's typed line.
-- Additive: no existing stage, deal or column changes; existing deals stay
-- where they are. Moves into the new stages are direct (owner's own rows);
-- Won / Lost keep their crm_close_deal approval.
insert into public.crm_stages (campaign_id, name, position, is_terminal) values
  ('_default', 'Conversation', 8, false),
  ('_default', 'Demo', 9, false),
  ('_default', 'Pilot', 10, false),
  ('_default', 'Paid', 11, true)
on conflict (campaign_id, name) do nothing;

alter table public.crm_deals
  add column if not exists pilot_start_date date,
  add column if not exists pilot_checkin_10_done_at timestamptz,
  add column if not exists pilot_checkin_25_done_at timestamptz,
  add column if not exists referral_asked_at timestamptz;

comment on column public.crm_deals.pilot_start_date is 'Owner-zone date the pilot started; check-ins fall due 10 and 25 days later.';
comment on column public.crm_deals.pilot_checkin_10_done_at is 'When the day-10 check-in was ticked done.';
comment on column public.crm_deals.pilot_checkin_25_done_at is 'When the day-25 check-in was ticked done.';
comment on column public.crm_deals.referral_asked_at is 'When the owner ticked that a referral was asked for.';

create index if not exists crm_deals_pilot_start_idx on public.crm_deals (pilot_start_date) where pilot_start_date is not null;

-- One row per owner-zone week (Monday): what the owner typed on /today.
-- Service role only, like every lume_ table.
create table if not exists public.lume_week_notes (
  week_start date primary key check (extract(isodow from week_start) = 1),
  top_objection text check (top_objection is null or length(top_objection) <= 300),
  updated_at timestamptz not null default now()
);
alter table public.lume_week_notes enable row level security;
revoke all on public.lume_week_notes from anon, authenticated;
