alter table validation_jobs
  add column if not exists icp_filter boolean not null default false,
  add column if not exists icp_description text;
