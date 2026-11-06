-- Review fixes for influencer candidates.
-- 1. A name match with an existing influencer is only a note now
--    (possible_duplicate_of), never a block: the person is still looked up,
--    and a hard duplicate needs the same linkedin_url (the lookup and the
--    approval check that).
-- 2. The agent's approve_influencer_candidates files an `influencer_approve`
--    approval (always asks): sheet and web text reach the agent, so it never
--    creates influencers on its own. The /influencers page button stays a
--    direct owner click.
alter table public.influencer_candidates
  add column if not exists possible_duplicate_of uuid references public.influencers(id) on delete set null;

alter table public.pending_actions drop constraint if exists pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly', 'launch_campaign', 'assign_leads', 'activate_rule', 'send_reply', 'pause_campaign',
  'resume_campaign', 'create_campaign', 'decide_gate', 'delete_rule', 'crm_close_deal', 'run_actor',
  'update_sequence', 'issue_operator_key', 'remove_leads', 'label_reply',
  'influencer_run', 'influencer_reactions', 'stage_attachment', 'influencer_lookup', 'influencer_approve'
]));
