-- Owner-editable settings (Lume Settings → Budget). The shared monthly Apify
-- cap moves here from the LUME_RESEARCH_APIFY_CAP_USD env (which stays the
-- fallback): influencer-reactions and company-research read it before every
-- Apify start; Lume shows it in estimates. Service role only.
create table if not exists public.lume_settings (
  key text primary key check (key ~ '^[a-z0-9_]{1,64}$'),
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.lume_settings enable row level security;
revoke all on public.lume_settings from anon, authenticated;

insert into public.lume_settings (key, value) values ('apify_monthly_cap_usd', '29'::jsonb)
on conflict (key) do nothing;

alter table public.lume_settings add constraint lume_settings_apify_cap_check
  check (key <> 'apify_monthly_cap_usd' or (jsonb_typeof(value) = 'number' and (value #>> '{}')::numeric > 0 and (value #>> '{}')::numeric <= 1000));
