-- Order #4199 sat in 'ordered' for 27 days: its poll chain died (the old
-- fire-and-forget self-invoke) and nothing watched apollo_orders. A live poll
-- heartbeats every ~60 s, so an 'ordered' row untouched for 20 minutes has no
-- poller. This restarts one (a free status read; delivery still lands as an
-- ingest awaiting the owner's Approve). Orders older than 14 days are left
-- alone; ordered_at = now() so a resumed poll gets its own 12 h window.
create or replace function public.leadsfriday_poll_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  key text;
  url text;
  o record;
begin
  select decrypted_secret into key from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into url from vault.decrypted_secrets where name = 'project_url';
  if key is null or url is null then return; end if;

  for o in
    select id from apollo_orders
    where status = 'ordered'
      and leadsfriday_order_id is not null
      and updated_at < now() - interval '20 minutes'
      and created_at > now() - interval '14 days'
  loop
    perform net.http_post(
      url     := url || '/functions/v1/leadsfriday-order',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || key, 'apikey', key),
      body    := jsonb_build_object('order_id', o.id, 'phase', 'poll', 'ordered_at', now())
    );
  end loop;
end $$;

revoke all on function public.leadsfriday_poll_sweep() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'leadsfriday-poll-sweep';
select cron.schedule('leadsfriday-poll-sweep', '*/15 * * * *', 'select public.leadsfriday_poll_sweep()');
