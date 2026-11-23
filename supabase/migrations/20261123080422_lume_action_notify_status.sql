-- Never skip a notification without a trace: each pending action records whether its
-- Telegram prompt was sent, and why not when it wasn't. Additive; existing rows stay null (unknown).
alter table public.pending_actions
  add column if not exists notify_status text check (notify_status in ('sent', 'skipped', 'failed')),
  add column if not exists notify_error text check (notify_error is null or length(notify_error) <= 300),
  add column if not exists notified_at timestamptz;
comment on column public.pending_actions.notify_status is 'Telegram prompt: sent | skipped (config missing) | failed (API error); null = created before 2026-11-23';
comment on column public.pending_actions.notify_error is 'Why the Telegram prompt was not sent, e.g. "missing token"';
