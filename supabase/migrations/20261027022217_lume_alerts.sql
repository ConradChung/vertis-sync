-- Grok Bot operator layer (Phase G4): the durable alert feed. Every outbound
-- notification (edge functions via _shared/alert.ts, Lume via lib/alerts.ts)
-- lands here whatever ALERT_CHANNELS says; /operator reads and acks it.
create table if not exists lume_alerts (
  id                uuid primary key default gen_random_uuid(),
  source            text not null,
  severity          text not null default 'info' check (severity in ('info','warn','urgent')),
  title             text not null,
  body              text,
  link              text,
  campaign_id       text,
  scope             text check (scope is null or scope in ('campaign','orders','replies','validation')),
  created_at        timestamptz not null default now(),
  acked_at          timestamptz,
  acked_by_operator uuid references lume_operators(id),
  -- Gate prompts carry '<gate or job id>:<gate kind>' so retries insert once
  -- (insert ... on conflict (dedupe_key) do nothing).
  dedupe_key        text unique
);
create index if not exists lume_alerts_unacked_idx on lume_alerts (acked_at, created_at desc);

-- Same shape as events: RLS on, owner-only read for the Realtime feed,
-- writes through the service role only.
alter table lume_alerts enable row level security;
revoke all on public.lume_alerts from anon, authenticated;
grant select on public.lume_alerts to authenticated;
drop policy if exists lume_alerts_owner_read on lume_alerts;
create policy lume_alerts_owner_read on lume_alerts
  for select to authenticated using ((select lume_is_owner()));

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='lume_alerts') then
    alter publication supabase_realtime add table public.lume_alerts;
  end if;
end $$;
