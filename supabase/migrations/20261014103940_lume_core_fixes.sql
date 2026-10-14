-- supabase/migrations/20261014103940_lume_core_fixes.sql
-- Lume: review fixes on top of lume_core (20261014102012). That migration is
-- already applied live, so everything here is additive and re-runnable.
--
-- OWNER SETUP (one-time, run as the project owner; nothing in Lume is readable
-- by the browser until this exists):
--   select vault.create_secret('<owner email>', 'lume_owner_email');
-- lume_is_owner() compares the caller's JWT email to that secret. This project
-- also issues `authenticated` JWTs to CRM client accounts, so a plain
-- `using (true)` read policy would leak events and agent prompts to them.
-- Default is deny: no secret -> false.

-- 1. Owner check + owner-scoped read policies ---------------------------------
create or replace function lume_is_owner() returns boolean
language sql stable security definer set search_path = public, pg_catalog as $$
  select coalesce(
    (select lower(auth.jwt() ->> 'email') = lower(decrypted_secret)
       from vault.decrypted_secrets where name = 'lume_owner_email' limit 1),
    false)
$$;
revoke all on function lume_is_owner() from public;
grant execute on function lume_is_owner() to authenticated;
-- Supabase default privileges also grant anon; it would only ever get false, but keep it tight.
revoke execute on function lume_is_owner() from anon;

drop policy if exists events_auth_read on events;
drop policy if exists pending_actions_auth_read on pending_actions;
drop policy if exists agent_runs_auth_read on agent_runs;
create policy events_auth_read on events
  for select to authenticated using ((select lume_is_owner()));
create policy pending_actions_auth_read on pending_actions
  for select to authenticated using ((select lume_is_owner()));
create policy agent_runs_auth_read on agent_runs
  for select to authenticated using ((select lume_is_owner()));

-- 2. events: real webhook_id column instead of a payload expression index ------
alter table events add column if not exists webhook_id text;
-- Backfill anything written under the old payload convention (no-op on a fresh table).
update events set webhook_id = payload->>'webhook_id'
  where webhook_id is null and payload ? 'webhook_id';
drop index if exists events_webhook_dedupe_idx;
create unique index if not exists events_webhook_id_idx
  on events (webhook_id) where webhook_id is not null;
create index if not exists events_campaign_idx
  on events (campaign_id, created_at desc) where campaign_id is not null;
create index if not exists events_source_idx on events (source, source_id);

-- 3. pending_actions: 'executing' state, executed_at, better indexes -----------
-- Constraint name verified in pg_constraint: pending_actions_status_check.
alter table pending_actions drop constraint if exists pending_actions_status_check;
alter table pending_actions add constraint pending_actions_status_check
  check (status in ('awaiting','approved','executing','executed','rejected','failed','expired'));
alter table pending_actions add column if not exists executed_at timestamptz;
-- Same name, new definition: drop first or `if not exists` would keep the old one.
drop index if exists pending_actions_open_idx;
create index if not exists pending_actions_open_idx
  on pending_actions (created_at) where status = 'awaiting';
create index if not exists pending_actions_agent_run_idx on pending_actions (agent_run_id);
create index if not exists pending_actions_rule_idx on pending_actions (rule_id);
create index if not exists agent_runs_approval_action_idx on agent_runs (approval_action_id);

-- 4. pending_actions <-> agent_runs FKs: deleting either side nulls the other --
alter table pending_actions drop constraint if exists pending_actions_agent_run_fk;
alter table pending_actions add constraint pending_actions_agent_run_fk
  foreign key (agent_run_id) references agent_runs(id) on delete set null;
alter table agent_runs drop constraint if exists agent_runs_approval_action_id_fkey;
alter table agent_runs add constraint agent_runs_approval_action_id_fkey
  foreign key (approval_action_id) references pending_actions(id) on delete set null;

-- 5. lume_campaigns seed rows get sentinel external_ids so the
--    (sender_type, external_id) unique key actually covers them ---------------
update lume_campaigns set external_id = 'gmail:recruiter'
  where external_id is null and sender_type = 'gmail' and name = 'Recruiter · GTM engineers (Gmail)';
update lume_campaigns set external_id = 'muse:auto-apply'
  where external_id is null and sender_type = 'muse' and name = 'Muse auto-apply';
comment on column rotation_rules.campaign_id is
  'Deliberate soft reference to lume_campaigns.external_id (Instantly campaign id); not a FK so rules survive campaign re-syncs.';
