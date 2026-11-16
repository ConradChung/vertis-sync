-- lead_bank.state is the rotation lifecycle state ('active', 'bounced'…), not a geographic state.
-- Use the source upload's geographic state; blank timezones/regions become null.
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
  nullif(b.region, '') as region,
  nullif(b.timezone, '') as timezone,
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
  coalesce(d.city, nullif(b.location, '')) as city,
  d.state as state,
  coalesce(d.country, nullif(b.country, '')) as country,
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
