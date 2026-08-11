-- Email-finder stage: rows that arrive without an email are resolved through
-- connector-os BEFORE validation, then merged back into the same list so the
-- whole set flows through MailTester together.
--
-- Rows the finder can't resolve get their own terminal state rather than being
-- lumped in with 'invalid'. "We never found an address" and "the address is
-- dead" are different outcomes, and conflating them made invalid_count
-- meaningless on lists that arrive partly blank.

alter table validation_rows drop constraint if exists validation_rows_status_check;
alter table validation_rows add constraint validation_rows_status_check
  check (status in ('pending', 'valid', 'invalid', 'error', 'no_email'));

alter table validation_jobs
  -- Off means skip the finder entirely and validate only the rows that
  -- already carry an address.
  add column if not exists find_emails boolean not null default true,
  add column if not exists rows_missing_email int not null default 0,
  add column if not exists emails_found int not null default 0,
  add column if not exists emails_not_found int not null default 0;

-- The finder repeatedly claims the next batch of blank-email rows for a job.
create index if not exists validation_rows_missing_email_idx
  on validation_rows (job_id, status, email);
