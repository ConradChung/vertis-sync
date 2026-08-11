-- Instantly push: send a finished job's valid leads straight into an Instantly
-- campaign, chosen by NAME over Telegram (never a raw campaign ID).
--
-- Two independent "barriers" gate the push. Defaults follow how the owner
-- actually works: location checking stays lax (keep the row, blank the unknown
-- city), company names get reviewed before anything is written to a live
-- campaign.

alter table validation_jobs
  -- Telegram force_reply threading: the campaign-name prompt's message_id.
  -- A plain-text reply whose reply_to_message.message_id matches this is the
  -- campaign name — Telegram's own threading does the state matching.
  add column if not exists instantly_prompt_message_id bigint,
  add column if not exists instantly_campaign_id text,
  add column if not exists instantly_campaign_name text,
  -- Candidate campaigns when a name search returns more than one hit, so the
  -- disambiguation callback can resolve an index back to an id without
  -- blowing Telegram's 64-byte callback_data budget.
  add column if not exists instantly_campaign_candidates jsonb,
  add column if not exists instantly_status text not null default 'idle'
    check (instantly_status in (
      'idle',               -- no push requested
      'awaiting_campaign',  -- force_reply sent, waiting on a campaign name
      'choosing_campaign',  -- multiple name matches, waiting on a button tap
      'configuring',        -- barrier toggles shown
      'reviewing_company',  -- first 10 company names shown for approval
      'pushing',
      'done',
      'cancelled',
      'error'
    )),
  -- Barriers. location OFF by default (lax), company ON by default (strict).
  add column if not exists location_barrier boolean not null default false,
  add column if not exists company_barrier boolean not null default true,
  -- Set from the company-name review screen: strip descriptive suffixes too
  -- ("Wildwood Management Group" -> "Wildwood"), not just legal ones.
  add column if not exists company_strict boolean not null default false,
  add column if not exists instantly_pushed int not null default 0,
  add column if not exists instantly_filtered int not null default 0,
  add column if not exists instantly_errors int not null default 0;

-- Per-row push state, mirroring the enrichment_status pattern so the push is
-- resumable across the edge function's self-re-invocations.
alter table validation_rows
  add column if not exists instantly_status text not null default 'skipped'
    check (instantly_status in ('skipped', 'pushed', 'filtered', 'error')),
  add column if not exists instantly_result jsonb;

-- The push loop repeatedly claims the next unpushed valid rows for one job.
create index if not exists validation_rows_instantly_push_idx
  on validation_rows (job_id, instantly_status, row_index);
