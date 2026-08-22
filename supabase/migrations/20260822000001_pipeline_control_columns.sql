-- Control columns for the three decision points that previously had none.
--
-- finder_status        the email-finder step is now a choice, not automatic.
--                      'awaiting_decision' while the Telegram prompt is live;
--                      the callback claims it by PATCHing
--                      ...&finder_status=eq.awaiting_decision -> 'decided',
--                      so a replayed callback or a tap on the other button
--                      matches zero rows and returns silently.
-- watchdog_status      same claim pattern for the watchdog's Resume button.
-- watchdog_notified_at caps stall notifications at one per job per hour.
-- enrich_started       one-way latch. The enricher chains back into
--                      email-validator when it finishes, and without this the
--                      validator would re-arm enrichment on that second pass
--                      and loop forever.

alter table validation_jobs
  add column if not exists finder_status        text        not null default 'idle',
  add column if not exists watchdog_status      text        not null default 'idle',
  add column if not exists watchdog_notified_at timestamptz,
  add column if not exists enrich_started       boolean     not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'validation_jobs_finder_status_check') then
    alter table validation_jobs add constraint validation_jobs_finder_status_check
      check (finder_status in ('idle', 'awaiting_decision', 'decided'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'validation_jobs_watchdog_status_check') then
    alter table validation_jobs add constraint validation_jobs_watchdog_status_check
      check (watchdog_status in ('idle', 'awaiting', 'claimed'));
  end if;
end $$;

-- The watchdog scans for stalled jobs every 5 minutes; without this it seq
-- scans validation_jobs each tick.
create index if not exists validation_jobs_active_idx
  on validation_jobs (status)
  where status in ('pending', 'processing');

-- The new stall heuristic is "no processed_at newer than 10 minutes", which
-- is a max(processed_at) per job on every tick.
create index if not exists validation_rows_job_processed_idx
  on validation_rows (job_id, processed_at desc);
