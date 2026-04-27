alter table validation_jobs
  drop constraint if exists validation_jobs_source_check;

alter table validation_jobs
  add constraint validation_jobs_source_check
  check (source in ('csv', 'apify', 'hnwi'));
