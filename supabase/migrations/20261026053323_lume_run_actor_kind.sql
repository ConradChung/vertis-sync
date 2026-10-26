-- Lume agent: pending_actions.kind += run_actor. An Apify actor run (spends
-- money, capped at $20 by Apify run options) goes through the Approve/Deny
-- gate; one awaiting action per identical request (actor + input + budget).
alter table public.pending_actions drop constraint if exists pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly','launch_campaign','assign_leads','activate_rule','send_reply','pause_campaign',
  'resume_campaign','create_campaign','decide_gate','delete_rule','crm_close_deal','run_actor']));
create unique index if not exists pending_actions_one_awaiting_run_actor_idx
  on public.pending_actions (kind, (payload->>'input_hash'))
  where status = 'awaiting' and kind = 'run_actor';
