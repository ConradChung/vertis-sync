-- GTM-18: numbered sheet steps + lead status (Maps leads -> the client portal).
--
-- Every lead moves through five steps: 1 Imported, 2 Combined, 3 Filtered,
-- 4 Validated, 5 In campaign. A lead row's status is the furthest step it
-- reached (pipeline_step) plus an optional note ("excluded: vendor"), shown as
-- "# · name" by lume_step_label() (the one place the text comes from; Lume's
-- lib/leads/steps.ts stepLabel mirrors it). A whole sheet (lead list) also
-- records its stage: imported, combined master or final sheet.
--
-- Portal: lume_portal_users gains sheet_set_ids (lead lists shared as call
-- sheets, starting with the Google Maps list), and lume_portal_sheet_leads
-- reads them (business, phone, website, city, rating, category, status).
-- The LinkedIn view gains the step columns at its end. Additive only: new
-- columns with defaults (no table rewrite), a new function and view, and
-- view columns appended. Portal user rows stay data, not part of this file.

alter table public.lead_review_items
  add column if not exists pipeline_step smallint not null default 1 check (pipeline_step between 1 and 5),
  add column if not exists step_note text check (step_note is null or length(step_note) <= 500);

alter table public.lead_review_sets
  add column if not exists sheet_stage text not null default 'imported' check (sheet_stage in ('imported', 'combined', 'final')),
  add column if not exists source_list_ids uuid[] not null default '{}',
  add column if not exists stage_spec jsonb check (stage_spec is null or jsonb_typeof(stage_spec) = 'object');

create or replace function public.lume_step_label(p_step integer, p_note text default null)
returns text
language sql
immutable
set search_path = public
as $$
  select s.n || ' · ' || (array['Imported', 'Combined', 'Filtered', 'Validated', 'In campaign'])[s.n]
      || coalesce(' — ' || nullif(btrim(regexp_replace(p_note, '\s+', ' ', 'g')), ''), '')
  from (select case when p_step between 1 and 5 then p_step else 1 end as n) s
$$;
grant execute on function public.lume_step_label(integer, text) to service_role;

alter table public.lume_portal_users
  add column if not exists sheet_set_ids uuid[] not null default '{}';

-- LinkedIn lists: unchanged columns, then the lead's step (appended at the end).
create or replace view public.lume_portal_linkedin_leads
with (security_invoker = true) as
select
  i.id,
  i.set_id,
  s.title as list_title,
  nullif(i.item->>'first_name', '') as first_name,
  nullif(i.item->>'last_name', '') as last_name,
  coalesce(nullif(i.item->>'name', ''), concat_ws(' ', i.item->>'first_name', i.item->>'last_name')) as full_name,
  nullif(i.item->>'title', '') as title,
  coalesce(nullif(i.item->>'company', ''), nullif(i.item->>'company_name', '')) as company_name,
  nullif(i.item->>'website', '') as website,
  nullif(i.item->>'domain', '') as company_domain,
  nullif(i.item->>'linkedin_url', '') as linkedin_url,
  nullif(i.item->>'email', '') as email,
  coalesce(nullif(i.item->>'phone', ''), ph.phone) as phone,
  nullif(i.item->>'city', '') as city,
  nullif(i.item->>'state', '') as state,
  nullif(i.item->>'country', '') as country,
  i.pipeline_step,
  public.lume_step_label(i.pipeline_step, i.step_note) as step_label
from lead_review_items i
join lead_review_sets s on s.id = i.set_id
left join lateral (
  select d.phone
  from lead_bank b2
  join lume_portal_lead_details d on d.lead_bank_id = b2.id
  where b2.company_domain is not null
    and b2.company_domain = nullif(i.item->>'domain', '')
    and d.phone is not null
  limit 1
) ph on true
where i.status is distinct from 'excluded'
  and s.archived_at is null;
revoke all on public.lume_portal_linkedin_leads from anon, authenticated;

-- Call sheets (Google Maps and other company lists): one row per business.
-- Excluded rows (dropouts) are left out, like the LinkedIn view. The helper
-- item holds the mapped fields (normaliseLead maps Maps' title / phone /
-- totalScore / categoryName); the sheet's own cells are the fallback.
create or replace view public.lume_portal_sheet_leads
with (security_invoker = true) as
select
  i.id,
  i.set_id,
  s.title as list_title,
  coalesce(nullif(i.item->>'company', ''), nullif(i.item->>'name', ''), nullif(i.cells->>'title', ''), nullif(i.cells->>'Company', '')) as company_name,
  nullif(concat_ws(' ', nullif(i.item->>'first_name', ''), nullif(i.item->>'last_name', '')), '') as person_name,
  nullif(i.item->>'title', '') as title,
  coalesce(nullif(i.item->>'category', ''), nullif(i.cells->>'categoryName', '')) as category,
  coalesce(nullif(i.item->>'phone', ''), nullif(i.cells->>'phone', ''), nullif(i.cells->>'phoneUnformatted', ''), nullif(i.cells->>'Phone', '')) as phone,
  coalesce(nullif(i.item->>'website', ''), nullif(i.cells->>'website', '')) as website,
  nullif(i.item->>'domain', '') as company_domain,
  nullif(i.item->>'email', '') as email,
  nullif(i.item->>'linkedin_url', '') as linkedin_url,
  coalesce(nullif(i.item->>'city', ''), nullif(i.cells->>'city', '')) as city,
  coalesce(nullif(i.item->>'state', ''), nullif(i.cells->>'state', '')) as state,
  coalesce(nullif(i.item->>'country', ''), nullif(i.cells->>'countryCode', '')) as country,
  case when (i.item->>'rating') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' then (i.item->>'rating')::numeric
       when (i.cells->>'totalScore') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' then (i.cells->>'totalScore')::numeric end as rating,
  case when (i.item->>'reviews_count') ~ '^\s*[0-9]+\s*$' then (i.item->>'reviews_count')::int end as reviews_count,
  i.pipeline_step,
  public.lume_step_label(i.pipeline_step, i.step_note) as step_label
from lead_review_items i
join lead_review_sets s on s.id = i.set_id
where i.status is distinct from 'excluded'
  and s.archived_at is null;
revoke all on public.lume_portal_sheet_leads from anon, authenticated;
