-- Lead review sets and lead lists show the columns the source actually has
-- (an Apify actor's own output fields, a sheet's headers), not Lume's mapped
-- fields. `columns`: the set's visible columns in source order (union over
-- every row, nested fields flattened as a.b, capped at 100). `cells`: one
-- row's flattened values by column. The mapped `item` stays as the hidden
-- helper for filters, dedupe and the validator's email column. Additive.
alter table public.lead_review_sets
  add column if not exists columns jsonb not null default '[]'::jsonb check (jsonb_typeof(columns) = 'array');
alter table public.lead_review_items
  add column if not exists cells jsonb check (cells is null or jsonb_typeof(cells) = 'object');
