alter table validation_jobs
  add column if not exists column_order jsonb;
