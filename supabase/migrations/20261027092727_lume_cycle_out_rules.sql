-- Lume Phase 2: rotation_rules.kind ('rotate' = the existing lead-bank →
-- campaign rule; 'cycle_out' = daily removal of finished, never-replied
-- leads, then an optional refill) and params (cycle_out: after_days, refill_to).
-- Existing rows become 'rotate' with '{}'. Rules are still created inactive
-- and activated only through a confirmed activate_rule.
alter table public.rotation_rules add column if not exists kind text not null default 'rotate';
alter table public.rotation_rules add column if not exists params jsonb not null default '{}'::jsonb;
alter table public.rotation_rules drop constraint if exists rotation_rules_kind_check;
alter table public.rotation_rules add constraint rotation_rules_kind_check check (kind in ('rotate','cycle_out'));
alter table public.rotation_rules drop constraint if exists rotation_rules_params_check;
alter table public.rotation_rules add constraint rotation_rules_params_check check (
  jsonb_typeof(params) = 'object'
  and (kind <> 'cycle_out' or (
    jsonb_typeof(params->'after_days') = 'number'
    and (params->>'after_days')::numeric between 1 and 365
    and (not params ? 'refill_to' or (jsonb_typeof(params->'refill_to') = 'number' and (params->>'refill_to')::numeric between 1 and 100000))
  ))
);
