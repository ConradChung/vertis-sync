-- Company names cleaned for cold-email copy by the owner's SOP
-- (supabase/functions/_shared/company_name.ts). Haiku's accepted answers only;
-- the deterministic rules are recomputed, never cached. Keyed by the raw name
-- and the email domain (SOP rule 7 reads the domain). sop_version bumps when
-- the SOP changes so old answers stop matching.
create table if not exists public.company_name_cleanings (
  raw         text not null,
  domain      text not null default '',
  sop_version int  not null,
  cleaned     text not null,
  created_at  timestamptz not null default now(),
  primary key (raw, domain, sop_version)
);

alter table public.company_name_cleanings enable row level security;
-- Service role only (edge functions); no policies.

-- Batched lookup: p_keys is a JSON array of {raw, domain}.
create or replace function public.company_name_cleanings_lookup(p_keys jsonb, p_version int)
returns table (raw text, domain text, cleaned text)
language sql stable
set search_path = public
as $$
  select c.raw, c.domain, c.cleaned
  from jsonb_to_recordset(p_keys) as k(raw text, domain text)
  join public.company_name_cleanings c
    on c.raw = k.raw and c.domain = coalesce(k.domain, '') and c.sop_version = p_version
$$;

revoke all on function public.company_name_cleanings_lookup(jsonb, int) from public, anon, authenticated;
grant execute on function public.company_name_cleanings_lookup(jsonb, int) to service_role;
