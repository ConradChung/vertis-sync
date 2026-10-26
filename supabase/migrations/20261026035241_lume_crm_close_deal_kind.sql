-- Lume CRM (part 5): pending_actions.kind += crm_close_deal. Moving a deal
-- to Won/Lost goes through the Approve/Deny gate; one awaiting per deal.
alter table public.pending_actions drop constraint if exists pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly','launch_campaign','assign_leads','activate_rule','send_reply','pause_campaign',
  'resume_campaign','create_campaign','decide_gate','delete_rule','crm_close_deal']));
create unique index if not exists pending_actions_one_awaiting_deal_idx
  on public.pending_actions (kind, (payload->>'deal_id'))
  where status = 'awaiting' and kind = 'crm_close_deal';
