-- Owner dropped the Apollo API path (manual Apollo export instead). Undo 20261026081057; no rows used the kind.
drop index if exists public.pending_actions_one_awaiting_apollo_idx;
do $$
begin
  if exists (select 1 from public.pending_actions where kind = 'apollo_enrich') then
    raise exception 'apollo_enrich rows exist; not removing the kind';
  end if;
end $$;
alter table public.pending_actions drop constraint pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly', 'launch_campaign', 'assign_leads', 'activate_rule', 'send_reply', 'pause_campaign',
  'resume_campaign', 'create_campaign', 'decide_gate', 'delete_rule', 'crm_close_deal', 'run_actor',
  'update_sequence'
]::text[]));
