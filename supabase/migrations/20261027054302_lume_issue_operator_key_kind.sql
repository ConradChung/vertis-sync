-- Lume G9: pending_actions.kind += issue_operator_key. The master Grok Bot's
-- agent can ask to mint a vertical operator key; the raw sign-in link is
-- returned once by the executor and never stored (payload/result hold a
-- masked form only). One awaiting request per vertical.
alter table public.pending_actions drop constraint if exists pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly','launch_campaign','assign_leads','activate_rule','send_reply','pause_campaign',
  'resume_campaign','create_campaign','decide_gate','delete_rule','crm_close_deal','run_actor',
  'update_sequence','issue_operator_key']));
create unique index if not exists pending_actions_one_awaiting_operator_key_idx
  on public.pending_actions ((payload->>'vertical_id'))
  where status = 'awaiting' and kind = 'issue_operator_key';
