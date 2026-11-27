-- Hiring rows and the per-company check cache keep the company's unit count (doors), mirroring signal_people.
-- Additive and nullable: a count is stored only when a cited source backs it, or the owner typed it ('owner').
alter table public.signal_hiring
  add column if not exists door_count int check (door_count is null or door_count > 0),
  add column if not exists door_count_source text check (door_count_source is null or length(door_count_source) <= 300),
  add column if not exists door_count_confidence text check (door_count_confidence is null or door_count_confidence in ('high','medium','low'));

alter table public.signal_company_checks
  add column if not exists door_count int check (door_count is null or door_count > 0),
  add column if not exists door_count_source text check (door_count_source is null or length(door_count_source) <= 300),
  add column if not exists door_count_confidence text check (door_count_confidence is null or door_count_confidence in ('high','medium','low'));
