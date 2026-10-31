-- {{compliance_law}} sends the operator shorthand when a jurisdiction has one
-- ("RTA", "Chapter 83", "Ejari"), else compliance_name, else "local
-- landlord-tenant law" (supabase/functions/_shared/research/jurisdiction.ts).
-- Activation still requires active = true AND compliance_name not null; a
-- short_name alone activates nothing. Nullable, not seeded (values are loaded
-- separately). Additive. copy_hook stays in place but is no longer read.
alter table public.jurisdictions
  add column if not exists short_name text check (short_name is null or length(btrim(short_name)) between 1 and 60);
comment on column public.jurisdictions.short_name is 'Operator shorthand sent as {{compliance_law}} (e.g. RTA); null = compliance_name is sent.';
comment on column public.jurisdictions.copy_hook is 'DEPRECATED: no longer read (replaced by compliance_name / short_name as {{compliance_law}}).';
