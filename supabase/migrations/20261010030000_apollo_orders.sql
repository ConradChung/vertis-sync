-- Apollo-link intake: the owner pastes an Apollo people-search URL into the
-- Telegram chat, picks a contact count, Leadsfriday runs the export, and the
-- delivered CSV enters the existing CSV approval pipeline (telegram_ingests ->
-- Approve/Deny -> validation -> Instantly) exactly as if it had been dropped
-- into the chat. See docs/plans/2026-10-09-jobsearch-pipeline-design.md,
-- "Revision 3".
--
-- count_status is the claim slot for the count buttons, same pattern as
-- job_batches.review_status.

create table if not exists apollo_orders (
  id                   uuid primary key default gen_random_uuid(),
  apollo_url           text,                                  -- null when tracking an order placed elsewhere
  contact_count        int,
  status               text not null default 'awaiting_count'
                       check (status in ('awaiting_count','ordering','ordered','delivered','ingested','cancelled','failed')),
  count_status         text not null default 'awaiting' check (count_status in ('awaiting','claimed')),
  leadsfriday_order_id bigint,
  leadsfriday_status   text,
  credits_deducted     numeric,
  new_balance          numeric,
  storage_path         text,                                  -- raw-uploads/leadsfriday/<id>.csv
  ingest_id            uuid references telegram_ingests(id),
  telegram_message_id  bigint,
  error                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

drop trigger if exists set_apollo_orders_updated_at on apollo_orders;
create trigger set_apollo_orders_updated_at
  before update on apollo_orders
  for each row execute function update_updated_at_column();

create index if not exists apollo_orders_active_idx on apollo_orders (status)
  where status in ('awaiting_count','ordering','ordered','delivered');
