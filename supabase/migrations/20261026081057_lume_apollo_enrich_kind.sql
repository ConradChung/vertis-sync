-- Lume: `apollo_enrich` pending action (find decision makers + reveal emails via the Apollo API, results staged at the ingest gate).
alter table public.pending_actions drop constraint pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly', 'launch_campaign', 'assign_leads', 'activate_rule', 'send_reply', 'pause_campaign',
  'resume_campaign', 'create_campaign', 'decide_gate', 'delete_rule', 'crm_close_deal', 'run_actor',
  'update_sequence', 'apollo_enrich'
]::text[]));

-- One awaiting enrichment per identical request (source + titles + per-company + cap).
create unique index if not exists pending_actions_one_awaiting_apollo_idx
  on public.pending_actions (kind, (payload ->> 'source_key'))
  where status = 'awaiting' and kind = 'apollo_enrich';
