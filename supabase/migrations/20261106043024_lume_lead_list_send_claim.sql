-- Claim a lead list's send to validation atomically: stamps sent_at only when
-- the list was never sent or its rows changed since (sent_at < content_changed_at),
-- so two quick clicks (or the page and the agent's approval) make one ingest.
-- Returns the previous sent_at (to release the claim if the ingest fails);
-- no row = not claimable (already sent unchanged, or not a live list).
create or replace function public.lume_claim_lead_list_send(p_list uuid)
returns table (prev_sent_at timestamptz, content_changed_at timestamptz)
language sql
security definer
set search_path = public
as $$
  with o as (
    select id, sent_at as prev
    from public.lead_review_sets
    where id = p_list and kind = 'list' and archived_at is null
    for update
  )
  update public.lead_review_sets s
     set sent_at = now(), sent_ingest_id = null, sent_rows = null
    from o
   where s.id = o.id and (o.prev is null or o.prev < s.content_changed_at)
  returning o.prev, s.content_changed_at;
$$;
revoke all on function public.lume_claim_lead_list_send(uuid) from public, anon, authenticated;
grant execute on function public.lume_claim_lead_list_send(uuid) to service_role;
