-- Lume CRM (part 1): stage list. Default stages live under campaign_id
-- '_default'; a campaign with its own rows uses those instead.
create table if not exists public.crm_stages (
  campaign_id text not null,
  name text not null check (length(name) between 1 and 60),
  position int not null,
  is_terminal boolean not null default false,
  primary key (campaign_id, name)
);

insert into public.crm_stages (campaign_id, name, position, is_terminal) values
  ('_default', 'Contacted', 0, false),
  ('_default', 'Replied', 1, false),
  ('_default', 'Interested', 2, false),
  ('_default', 'Meeting booked', 3, false),
  ('_default', 'Won', 4, true),
  ('_default', 'Lost', 5, true),
  ('_default', 'Bounced', 6, true),
  ('_default', 'Not now', 7, false)
on conflict (campaign_id, name) do nothing;

alter table public.crm_stages enable row level security;
create policy crm_stages_owner_read on public.crm_stages for select to authenticated using ((select public.lume_is_owner()));
