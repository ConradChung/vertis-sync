-- Live ETA, split by stage. telegram-inbox's quoteEta still writes the first
-- eta_seconds at decision time (stage null = that initial quote).
-- email-validator and operating-city-enricher now overwrite it after each
-- batch from the throughput they measure (supabase/functions/_shared/eta.ts):
--   eta_stage             'validating' | 'enriching' (null: the initial quote)
--   eta_validate_seconds  what is left of validation at eta_updated_at
--   eta_enrich_seconds    the enrichment still to come (null when the job does not enrich)
-- Additive and nullable.
alter table public.validation_jobs
  add column if not exists eta_stage text check (eta_stage is null or eta_stage in ('validating', 'enriching')),
  add column if not exists eta_validate_seconds integer check (eta_validate_seconds is null or eta_validate_seconds >= 0),
  add column if not exists eta_enrich_seconds integer check (eta_enrich_seconds is null or eta_enrich_seconds >= 0);
