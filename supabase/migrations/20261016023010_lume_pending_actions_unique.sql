-- supabase/migrations/20261016023010_lume_pending_actions_unique.sql
-- Lume: at most one awaiting pending action per (kind, job).
--
-- lume/lib/actions/create.ts checks for an awaiting action before inserting,
-- but check-then-insert races (a double click, the agent and the owner at the
-- same moment). This index makes the second insert fail with 23505, which
-- createAction maps to DuplicateActionError (HTTP 409). Rows without a job_id
-- (rotation rules, replies) are not constrained.
create unique index if not exists pending_actions_one_awaiting_idx
  on pending_actions (kind, (payload->>'job_id'))
  where status = 'awaiting' and payload ? 'job_id';
