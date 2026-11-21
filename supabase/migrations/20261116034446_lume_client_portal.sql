-- Lume client portal: read-only view of a client's campaign leads for an external user.
-- All access goes through service-role API routes that filter by lume_portal_users.campaign_ids.
-- Portal user rows are data, inserted separately (not in this migration).

create table public.lume_portal_users (
  email text primary key check (email = lower(email)),
  client text not null,
  campaign_ids text[] not null default '{}',
  linkedin_set_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);
alter table public.lume_portal_users enable row level security;
revoke all on public.lume_portal_users from anon, authenticated;

-- Per-lead contact details copied once from the source upload (validation_rows.row_data),
-- so portal reads never parse raw jsonb.
create table public.lume_portal_lead_details (
  lead_bank_id bigint primary key references public.lead_bank(id) on delete cascade,
  title text,
  phone text,
  phone_type text check (phone_type in ('mobile', 'company')),
  linkedin_url text,
  city text,
  state text,
  country text,
  refreshed_at timestamptz not null default now()
);
alter table public.lume_portal_lead_details enable row level security;
revoke all on public.lume_portal_lead_details from anon, authenticated;

create or replace function public.lume_portal_refresh_details()
returns integer
language sql
security definer
set search_path = public
as $$
  with todo as (
    select b.id, b.source_job_id, lower(b.email) as em
    from lead_bank b
    where b.pushed_at is not null
      and not exists (select 1 from lume_portal_lead_details d where d.lead_bank_id = b.id)
  ),
  vr as (
    select distinct on (v.job_id, lower(v.email)) v.job_id, lower(v.email) as em, v.row_data
    from validation_rows v
    where v.job_id in (select distinct t.source_job_id from todo t where t.source_job_id is not null)
      and v.email is not null
    order by v.job_id, lower(v.email), v.row_index
  ),
  ins as (
    insert into lume_portal_lead_details (lead_bank_id, title, phone, phone_type, linkedin_url, city, state, country)
    select
      t.id,
      nullif(trim(vr.row_data->>'Title'), ''),
      coalesce(nullif(trim(vr.row_data->>'Mobile Phone'), ''),
               nullif(trim(vr.row_data->>'Corporate Phone'), ''),
               nullif(trim(vr.row_data->>'Company Phone'), '')),
      case
        when nullif(trim(vr.row_data->>'Mobile Phone'), '') is not null then 'mobile'
        when coalesce(nullif(trim(vr.row_data->>'Corporate Phone'), ''), nullif(trim(vr.row_data->>'Company Phone'), '')) is not null then 'company'
      end,
      nullif(trim(vr.row_data->>'Person Linkedin Url'), ''),
      nullif(trim(vr.row_data->>'City'), ''),
      nullif(trim(vr.row_data->>'State'), ''),
      nullif(trim(vr.row_data->>'Country'), '')
    from todo t
    left join vr on vr.job_id = t.source_job_id and vr.em = t.em
    on conflict (lead_bank_id) do nothing
    returning 1
  )
  select count(*)::int from ins;
$$;
revoke all on function public.lume_portal_refresh_details() from public, anon, authenticated;
grant execute on function public.lume_portal_refresh_details() to service_role;

-- Callable leads: pushed, not stopped (not-ICP), not unsubscribed (final_status -2),
-- and no negative reply (-1 not interested, -2 wrong person, -3 lost). Out-of-office (0) is ignored.
create or replace view public.lume_portal_leads
with (security_invoker = true) as
with rep as (
  select distinct on (r.campaign_id, lower(r.lead_email)) r.campaign_id, lower(r.lead_email) as em, r.interest
  from lume_replies r
  where r.interest is not null
  order by r.campaign_id, lower(r.lead_email), r.received_at desc
),
base as (
  select b.*,
    coalesce(rep.interest::int,
             case when b.interest_status ~ '^-?[0-9]+$' then b.interest_status::int end) as interest
  from lead_bank b
  left join rep on rep.campaign_id = b.campaign_id and rep.em = lower(b.email)
  where b.pushed_at is not null and b.stopped_at is null
)
select
  b.id,
  b.campaign_id,
  c.name as campaign_name,
  b.region,
  b.timezone,
  b.first_name,
  b.last_name,
  b.email,
  b.company_name,
  b.website,
  b.company_domain,
  d.title,
  d.phone,
  d.phone_type,
  d.linkedin_url,
  coalesce(d.city, b.location) as city,
  coalesce(b.state, d.state) as state,
  coalesce(b.country, d.country) as country,
  b.email_open_count,
  b.email_reply_count,
  case b.interest
    when 1 then 'Interested'
    when 2 then 'Meeting booked'
    when 3 then 'Meeting completed'
    when 4 then 'Won'
  end as reply_status,
  b.pushed_at,
  b.finished_at
from base b
left join lume_portal_lead_details d on d.lead_bank_id = b.id
left join lume_campaigns c on c.external_id = b.campaign_id
where coalesce(b.final_status, 0) <> -2
  and coalesce(b.interest, 0) not in (-1, -2, -3);
revoke all on public.lume_portal_leads from anon, authenticated;

-- LinkedIn-outreach lists (lead_review_items), with a company phone matched by domain when known.
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
  nullif(i.item->>'country', '') as country
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

create index if not exists lead_bank_company_domain_idx on public.lead_bank (company_domain) where company_domain is not null;

select cron.schedule('lume-portal-refresh-details', '*/15 * * * *', $cron$select public.lume_portal_refresh_details()$cron$);
