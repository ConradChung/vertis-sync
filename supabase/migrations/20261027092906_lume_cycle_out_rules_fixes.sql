-- lume_cycle_out_rules: a missing after_days made the check NULL (passes).
-- Coalesce so cycle_out without a numeric after_days in 1..365 is refused.
alter table public.rotation_rules drop constraint if exists rotation_rules_params_check;
alter table public.rotation_rules add constraint rotation_rules_params_check check (
  jsonb_typeof(params) = 'object'
  and (kind <> 'cycle_out' or coalesce(
    jsonb_typeof(params->'after_days') = 'number'
    and (params->>'after_days')::numeric between 1 and 365
    and (not params ? 'refill_to' or (jsonb_typeof(params->'refill_to') = 'number' and (params->>'refill_to')::numeric between 1 and 100000)),
    false
  ))
);
