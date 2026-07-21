alter table validation_rows
  add column if not exists enrichment_status text not null default 'skipped'
    check (enrichment_status in ('skipped', 'pending', 'done', 'unknown', 'error')),
  add column if not exists enrichment jsonb;

alter table validation_jobs
  add column if not exists enrich boolean not null default false,
  add column if not exists enriched_rows int not null default 0;
