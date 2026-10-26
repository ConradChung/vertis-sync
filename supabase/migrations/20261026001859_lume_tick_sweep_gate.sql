-- supabase/migrations/20261026001859_lume_tick_sweep_gate.sql
-- Lume: the rotation tick also POSTs when an approved pending action has not
-- executed within 2 minutes of its decision, so /api/cron/rotation-tick's
-- sweeper (which re-dispatches stuck approvals to /api/actions/:id/execute)
-- runs even when no rule is due and nothing awaiting is stale. Everything else
-- is unchanged from 20261025234511_lume_cron_fixes.sql: same signature, owner,
-- search_path, lock_timeout, grants, and still no exception handler.

create or replace function public.lume_rotation_tick() returns void
language plpgsql security definer
set search_path = pg_catalog, public
set lock_timeout = '1s'
as $$
declare
  url text; secret text;
begin
  select decrypted_secret into url from vault.decrypted_secrets where name = 'lume_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'lume_hook_secret';
  if url is null or secret is null then return; end if;
  if not exists (select 1 from rotation_rules
                 where active and (next_run_at is null or next_run_at <= now()))
     and not exists (select 1 from pending_actions
                     where status = 'awaiting' and created_at < now() - interval '24 hours')
     and not exists (select 1 from pending_actions
                     where status = 'approved' and executed_at is null
                       and decided_at < now() - interval '2 minutes') then
    return;
  end if;
  perform net.http_post(
    url     := url || '/api/cron/rotation-tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Lume-Hook-Secret', secret),
    body    := '{}'::jsonb);
end $$;
revoke all on function public.lume_rotation_tick() from public, anon, authenticated;
