-- Lume research P4 (minimal): seed public.jurisdictions.
--
-- Every row ships active = false. The owner reviews the copy_hook sentences in
-- docs/lume/2026-10-30-jurisdiction-hooks.md and activates rows with one
-- UPDATE; until then the resolver matches nothing and every lead gets its
-- SOP fallback sentence as {{jurisdiction_line}}.
--
-- region is the canonical full name normalizeRegion() returns
-- (supabase/functions/_shared/research/jurisdiction.ts): "Texas",
-- "British Columbia", "Dubai". compliance_name / authority / copy_hook are set
-- only where verified on 2026-10-30 (verified_at); every other row is the
-- jurisdiction name only. Singapore has no row on purpose (fallback).
--
-- Verified 2026-10-30:
--   BC: Residential Tenancy Act (s. 52: a landlord's notice to end tenancy must
--     be signed, dated, give the address and grounds, and be on the approved
--     form; an arbitrator may amend a defective notice), administered by the
--     Residential Tenancy Branch.
--   ON: Residential Tenancies Act, 2006, Landlord and Tenant Board; s. 12.1:
--     standard form of lease; a tenant may demand it in writing and, if it is
--     not provided within 21 days, withhold up to one month's rent.
--   UK: Renters' Rights Act 2025 received Royal Assent on 27 October 2025
--     (gov.uk implementation roadmap, Annex A). Phase 1 commenced 1 May 2026
--     (gov.uk press release "Historic protections for renters in action across
--     England", 30 April 2026): section 21 "no-fault" evictions abolished,
--     tenancies periodic, rent increases once a year; section 21 notices served
--     before 1 May 2026 had to reach court by 31 July 2026. Phase 2 (PRS
--     database) from late 2026; phase 3 (Decent Homes, Awaab's Law) subject to
--     consultation. The Act applies to ENGLAND only; Wales is under the Renting
--     Homes (Wales) Act 2016. The row is labelled "England and Wales" with
--     region null as briefed, so the hook names England; see the review note.
--     Sources: https://www.gov.uk/government/publications/renters-rights-act-2025-implementation-roadmap
--              https://www.gov.uk/government/news/historic-protections-for-renters-in-action-across-england
--   Dubai: RERA (Real Estate Regulatory Agency, Dubai Land Department); Ejari
--     tenancy registration; the Rental Disputes Centre lists the Ejari
--     certificate among the documents for a case.

insert into public.jurisdictions (country, region, jurisdiction) values
  ('US', 'Alabama', 'Alabama'),
  ('US', 'Alaska', 'Alaska'),
  ('US', 'Arizona', 'Arizona'),
  ('US', 'Arkansas', 'Arkansas'),
  ('US', 'California', 'California'),
  ('US', 'Colorado', 'Colorado'),
  ('US', 'Connecticut', 'Connecticut'),
  ('US', 'Delaware', 'Delaware'),
  ('US', 'District of Columbia', 'District of Columbia'),
  ('US', 'Florida', 'Florida'),
  ('US', 'Georgia', 'Georgia'),
  ('US', 'Hawaii', 'Hawaii'),
  ('US', 'Idaho', 'Idaho'),
  ('US', 'Illinois', 'Illinois'),
  ('US', 'Indiana', 'Indiana'),
  ('US', 'Iowa', 'Iowa'),
  ('US', 'Kansas', 'Kansas'),
  ('US', 'Kentucky', 'Kentucky'),
  ('US', 'Louisiana', 'Louisiana'),
  ('US', 'Maine', 'Maine'),
  ('US', 'Maryland', 'Maryland'),
  ('US', 'Massachusetts', 'Massachusetts'),
  ('US', 'Michigan', 'Michigan'),
  ('US', 'Minnesota', 'Minnesota'),
  ('US', 'Mississippi', 'Mississippi'),
  ('US', 'Missouri', 'Missouri'),
  ('US', 'Montana', 'Montana'),
  ('US', 'Nebraska', 'Nebraska'),
  ('US', 'Nevada', 'Nevada'),
  ('US', 'New Hampshire', 'New Hampshire'),
  ('US', 'New Jersey', 'New Jersey'),
  ('US', 'New Mexico', 'New Mexico'),
  ('US', 'New York', 'New York'),
  ('US', 'North Carolina', 'North Carolina'),
  ('US', 'North Dakota', 'North Dakota'),
  ('US', 'Ohio', 'Ohio'),
  ('US', 'Oklahoma', 'Oklahoma'),
  ('US', 'Oregon', 'Oregon'),
  ('US', 'Pennsylvania', 'Pennsylvania'),
  ('US', 'Rhode Island', 'Rhode Island'),
  ('US', 'South Carolina', 'South Carolina'),
  ('US', 'South Dakota', 'South Dakota'),
  ('US', 'Tennessee', 'Tennessee'),
  ('US', 'Texas', 'Texas'),
  ('US', 'Utah', 'Utah'),
  ('US', 'Vermont', 'Vermont'),
  ('US', 'Virginia', 'Virginia'),
  ('US', 'Washington', 'Washington'),
  ('US', 'West Virginia', 'West Virginia'),
  ('US', 'Wisconsin', 'Wisconsin'),
  ('US', 'Wyoming', 'Wyoming'),
  ('CA', 'Alberta', 'Alberta'),
  ('CA', 'Manitoba', 'Manitoba'),
  ('CA', 'New Brunswick', 'New Brunswick'),
  ('CA', 'Newfoundland and Labrador', 'Newfoundland and Labrador'),
  ('CA', 'Northwest Territories', 'Northwest Territories'),
  ('CA', 'Nova Scotia', 'Nova Scotia'),
  ('CA', 'Nunavut', 'Nunavut'),
  ('CA', 'Prince Edward Island', 'Prince Edward Island'),
  ('CA', 'Quebec', 'Quebec'),
  ('CA', 'Saskatchewan', 'Saskatchewan'),
  ('CA', 'Yukon', 'Yukon'),
  ('AU', 'New South Wales', 'New South Wales'),
  ('AU', 'Victoria', 'Victoria'),
  ('AU', 'Queensland', 'Queensland'),
  ('AU', 'Western Australia', 'Western Australia'),
  ('AU', 'South Australia', 'South Australia'),
  ('AU', 'Tasmania', 'Tasmania'),
  ('AU', 'Australian Capital Territory', 'Australian Capital Territory'),
  ('AU', 'Northern Territory', 'Northern Territory');

insert into public.jurisdictions (country, region, jurisdiction, compliance_name, authority, copy_hook, verified_at) values
  ('CA', 'British Columbia', 'British Columbia', 'Residential Tenancy Act', 'Residential Tenancy Branch',
   'In BC, a landlord''s notice to end tenancy must be on the approved RTB form, signed and dated, or it can fail at dispute.',
   '2026-10-30T00:00:00Z'),
  ('CA', 'Ontario', 'Ontario', 'Residential Tenancies Act, 2006', 'Landlord and Tenant Board',
   'In Ontario, a tenant without the standard lease can demand one in writing and withhold a month''s rent if it isn''t provided within 21 days.',
   '2026-10-30T00:00:00Z'),
  ('GB', null, 'England and Wales', 'Renters'' Rights Act 2025', null,
   'In England, section 21 ended on 1 May 2026, so every possession claim now needs a ground and the paperwork to prove it.',
   '2026-10-30T00:00:00Z'),
  ('AE', 'Dubai', 'Dubai', 'Ejari tenancy registration', 'RERA',
   'In Dubai, the Rental Disputes Centre expects an Ejari-registered lease before it hears a case, renewals included.',
   '2026-10-30T00:00:00Z');
