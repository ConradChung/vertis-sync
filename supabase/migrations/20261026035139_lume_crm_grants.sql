-- Lume CRM (part 3): the browser roles only ever read (RLS); writes are service role.
revoke insert, update, delete, truncate on public.crm_stages, public.crm_deals, public.crm_activities from anon, authenticated;
revoke all on public.crm_stages, public.crm_deals, public.crm_activities from anon;
