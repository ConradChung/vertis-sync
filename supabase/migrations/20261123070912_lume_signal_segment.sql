-- GTM-14: owner-operators who self-manage are kept and carded, labelled apart
-- from management companies. Additive: existing rows are 'pm'.
alter table public.signal_people
  add column if not exists segment text not null default 'pm'
  check (segment in ('pm', 'owner_operator'));
comment on column public.signal_people.segment is
  'pm = third-party property management company; owner_operator = owns and self-manages rentals (card label "owner-operator")';
