-- pgTAP: jurisdiction seed + lead_bank country/region/jurisdiction_line
-- (migrations lume_jurisdictions_seed, lume_lead_bank_jurisdiction).
-- Everything rolls back.
begin;
select plan(16);

-- seed -----------------------------------------------------------------------
select is((select count(*)::int from public.jurisdictions where country = 'US' and city_match is null), 51, 'US: 50 states + DC');
select is((select count(*)::int from public.jurisdictions where country = 'CA' and city_match is null), 13, 'Canada: 13 provinces and territories');
select is((select count(*)::int from public.jurisdictions where country = 'AU' and city_match is null), 8, 'Australia: 8 states and territories');
select is((select count(*)::int from public.jurisdictions where country = 'SG'), 0, 'Singapore: no row (fallback)');
select ok(
  exists(select 1 from public.jurisdictions where country = 'GB' and region is null and jurisdiction = 'England and Wales' and verified_at is not null),
  'UK: one country-wide England and Wales row, verified');
select ok(
  exists(select 1 from public.jurisdictions where country = 'AE' and region = 'Dubai' and authority = 'RERA'
           and compliance_name = 'Ejari tenancy registration'),
  'UAE: Dubai, RERA, Ejari');
select ok(
  exists(select 1 from public.jurisdictions where country = 'CA' and region = 'British Columbia'
           and compliance_name = 'Residential Tenancy Act' and authority = 'Residential Tenancy Branch'),
  'BC: RTA / RTB');
select ok(
  exists(select 1 from public.jurisdictions where country = 'CA' and region = 'Ontario'
           and compliance_name = 'Residential Tenancies Act, 2006' and authority = 'Landlord and Tenant Board'),
  'ON: RTA 2006 / LTB');
select is((select count(*)::int from public.jurisdictions where active), 0, 'every seeded row ships inactive');
select is(
  (select array_agg(jurisdiction order by jurisdiction) from public.jurisdictions where copy_hook is not null),
  array['British Columbia', 'Dubai', 'England and Wales', 'Ontario'],
  'hooks only on the four verified rows');
select ok(
  not exists(select 1 from public.jurisdictions where copy_hook is not null
               and (verified_at is null or copy_hook like '%!%'
                    or array_length(regexp_split_to_array(btrim(copy_hook), '\s+'), 1) > 25)),
  'every hook is verified, at most 25 words, no exclamation');

-- lead_bank columns ----------------------------------------------------------
select has_column('public', 'lead_bank', 'country', 'lead_bank.country');
select has_column('public', 'lead_bank', 'region', 'lead_bank.region');
select has_column('public', 'lead_bank', 'jurisdiction_line', 'lead_bank.jurisdiction_line');
select throws_ok(
  $$insert into public.lead_bank(campaign_id, email, country) values ('pgtap', 'pgtap@x.test', 'Canada')$$,
  '23514', null, 'country must be ISO2');
select ok(
  (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
    where table_schema = 'public' and table_name = 'lume_lead_bank')[12:14] = array['country', 'region', 'jurisdiction_line'],
  'lume_lead_bank exposes country, region, jurisdiction_line');

select * from finish();
rollback;
