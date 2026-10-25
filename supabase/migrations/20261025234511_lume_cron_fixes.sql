-- supabase/migrations/20261025234511_lume_cron_fixes.sql
-- Lume: rotation tick fixes for Task 11 (Rotate).
--
-- 1. lume_rotation_tick() also POSTs when an awaiting pending action is older
--    than 24 h, so /api/cron/rotation-tick expires stale actions even when no
--    rule is due (an idle Lume with one forgotten confirmation still cleans
--    up). The existence check rides pending_actions_open_idx (created_at,
--    where status = 'awaiting').
-- 2. Its `exception when others` handler is gone: a broken tick (pg_net
--    missing, a lock timeout on rotation_rules) now fails the cron run and
--    shows as `failed` in cron.job_run_details instead of a warning nobody
--    reads. The trigger functions keep their handlers: a failed gate ping must
--    never roll back the pipeline write that fired it; the tick has no such
--    write to protect.
-- 3. At most one awaiting pending action per (kind, rule). The rotation-tick
--    route claims a rule by advancing next_run_at and then checks for an
--    awaiting assign_leads action with that rule_id; this index backs the
--    check so two overlapping ticks can never both insert (the loser gets
--    23505, which the route maps to "skipped"). It also keeps one awaiting
--    activate_rule / delete_rule per rule. Rows without a rule_id are not
--    constrained (pending_actions_one_awaiting_idx covers job-scoped kinds).
--
-- Same signature, owner, search_path, lock_timeout and grants as
-- 20261014213932_lume_cron.sql; the cron job keeps calling it unchanged.

create unique index if not exists pending_actions_one_awaiting_rule_idx
  on pending_actions (kind, rule_id)
  where status = 'awaiting' and rule_id is not null;

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
                     where status = 'awaiting' and created_at < now() - interval '24 hours') then
    return;
  end if;
  perform net.http_post(
    url     := url || '/api/cron/rotation-tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Lume-Hook-Secret', secret),
    body    := '{}'::jsonb);
end $$;
revoke all on function public.lume_rotation_tick() from public, anon, authenticated;
