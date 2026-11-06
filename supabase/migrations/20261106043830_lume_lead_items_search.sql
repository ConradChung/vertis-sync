-- Leads page search at 20k rows: one lower-cased text of the helper fields per
-- row (generated, so it never drifts from item) behind a trigram index, so
-- `search_text ilike '%term%'` is an index lookup instead of a jsonb scan.
create extension if not exists pg_trgm with schema extensions;
alter table public.lead_review_items
  add column if not exists search_text text generated always as (
    lower(
      coalesce(item->>'name', '') || ' ' || coalesce(item->>'first_name', '') || ' ' || coalesce(item->>'last_name', '') || ' ' ||
      coalesce(item->>'company', '') || ' ' || coalesce(item->>'email', '') || ' ' || coalesce(item->>'title', '') || ' ' ||
      coalesce(item->>'city', '') || ' ' || coalesce(item->>'domain', '')
    )
  ) stored;
create index if not exists lead_review_items_search_trgm_idx on public.lead_review_items using gin (search_text extensions.gin_trgm_ops);
