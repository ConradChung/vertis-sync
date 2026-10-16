-- supabase/migrations/20261015071538_lume_events_webhook_index.sql
-- Lume: make events_webhook_id_idx a plain (non-partial) unique index.
--
-- 20261014103940 created it `where webhook_id is not null`. That predicate
-- bought nothing: NULLs never conflict in a unique btree index, so rows
-- without a webhook_id were already free to coexist. It did, however, break
-- PostgREST's upsert — `?on_conflict=webhook_id` emits
-- `ON CONFLICT (webhook_id) DO ...` without the predicate, and Postgres can
-- only match that arbiter to a non-partial unique index (42P10 "there is no
-- unique or exclusion constraint matching the ON CONFLICT specification").
-- Applied live via the Supabase MCP on 2026-10-15; re-runnable.
drop index if exists events_webhook_id_idx;
create unique index if not exists events_webhook_id_idx on events (webhook_id);
