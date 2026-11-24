-- GTM-15: keep each F5Bot alert email as received (plain + HTML), so the
-- comment text in the HTML part can be parsed and re-parsed later. Additive
-- only; service role only.
create table if not exists public.signal_f5bot_emails (
  id          bigint generated always as identity primary key,
  message_id  text unique,
  subject     text,
  body        text,
  html        text,
  received_at timestamptz not null default now()
);
alter table public.signal_f5bot_emails enable row level security;
revoke all on public.signal_f5bot_emails from anon, authenticated;
revoke all on sequence public.signal_f5bot_emails_id_seq from anon, authenticated;
