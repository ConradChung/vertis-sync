-- Blitz contact lookup for the Hiring Ops Signal (lume/lib/hiring/contact.ts). Additive only.
alter table public.signal_hiring
  add column if not exists contact_name     text,
  add column if not exists contact_title    text,
  add column if not exists contact_linkedin text,
  add column if not exists contact_email    text,
  add column if not exists contact_source   text
    check (contact_source is null or contact_source in ('person', 'waterfall', 'none'));

comment on column public.signal_hiring.contact_email is
  'Verified work email from Blitz (/v2/enrichment/email) for the named person or the one decision-maker Waterfall ICP found.';
comment on column public.signal_hiring.contact_source is
  'person = the row''s named person; waterfall = one decision-maker found for the company; none = looked up, nothing found; null = never looked up.';
