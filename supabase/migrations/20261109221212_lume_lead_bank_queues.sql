-- The lead bank per campaign (owner, 2026-11-09: "why is there just a giant
-- lead bank, how am I supposed to know which one rotates into which"): one
-- row per campaign with its queue, what's in Instantly and what finished, and
-- when its oldest queued lead was banked (rotation is oldest-first).
create or replace function public.lume_lead_bank_queues()
returns table (campaign_id text, queued bigint, active bigint, finished bigint, oldest_queued_at timestamptz, last_pushed_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select campaign_id::text,
         count(*) filter (where state = 'queued'),
         count(*) filter (where state = 'active'),
         count(*) filter (where state in ('completed', 'bounced', 'skipped', 'orphaned')),
         min(created_at) filter (where state = 'queued'),
         max(pushed_at)
  from lead_bank
  group by campaign_id
$$;
revoke all on function public.lume_lead_bank_queues() from public, anon, authenticated;
grant execute on function public.lume_lead_bank_queues() to service_role;
