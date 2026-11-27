-- LinkedIn draft generator: optional story behind a fact (owner-supplied, real only).
alter table public.content_facts add column if not exists detail text check (detail is null or length(btrim(detail)) between 3 and 2000);
