-- Inbox manager 3e + 3f (docs/lume/2026-10-28-inbox-manager-design.md).
--
-- 1. pending_actions.decided_via gains 'grant' (a campaign in Auto reply
--    mode approved a send_reply with nobody tapping; 3e) and 'client' (a
--    client approving in Slack; 3g, not used yet).
-- 2. lume_campaign_reply_modes: the per-campaign reply approval mode, keyed
--    by the Instantly campaign id (send_reply payload.campaign_id). Not on
--    lume_campaigns: that registry holds no Instantly campaigns (the main
--    campaign has no row). A campaign with no row is 'owner'. Service role
--    only; the route that changes it is owner-session only.
-- 3. lume_vertical_webhooks: an optional outbound webhook (Grok routine) per
--    vertical, with its HMAC secret. The secret never leaves the server (the
--    API returns it masked). Service role only.

alter table public.pending_actions drop constraint pending_actions_decided_via_check;
alter table public.pending_actions add constraint pending_actions_decided_via_check
  check (decided_via = any (array['lume', 'telegram', 'agent', 'operator', 'grant', 'client']));

create table public.lume_campaign_reply_modes (
  campaign_id text primary key check (campaign_id ~ '^[A-Za-z0-9_:-]{1,80}$'),
  mode text not null default 'owner' check (mode in ('owner', 'client', 'auto')),
  updated_at timestamptz not null default now(),
  updated_by text check (updated_by is null or length(updated_by) <= 120)
);
alter table public.lume_campaign_reply_modes enable row level security;
revoke all on public.lume_campaign_reply_modes from anon, authenticated;

create table public.lume_vertical_webhooks (
  vertical_id uuid primary key references public.lume_verticals(id) on delete cascade,
  url text not null check (url ~ '^https://' and length(url) <= 2000),
  secret text not null check (length(secret) between 16 and 200),
  updated_at timestamptz not null default now(),
  last_delivery_at timestamptz,
  last_delivery_ok boolean,
  last_error text check (last_error is null or length(last_error) <= 300)
);
alter table public.lume_vertical_webhooks enable row level security;
revoke all on public.lume_vertical_webhooks from anon, authenticated;
