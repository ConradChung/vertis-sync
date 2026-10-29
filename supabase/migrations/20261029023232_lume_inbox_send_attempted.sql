-- Inbox manager review fixes (3b):
--
-- 1. pending_actions.send_attempted: set by the send_reply executor right
--    before it calls Instantly /emails/reply. A reply whose send was
--    attempted may have gone out even if the row later failed or was marked
--    interrupted, so it keeps blocking a new reply to the same inbound email.
--    pending_actions_one_reply_per_inbound_idx (lume_inbox_replies) is
--    replaced with that wider predicate.
-- 2. label_reply becomes a pending-action kind: a blocking label (unsubscribe,
--    hostile, BAD + block) requested by the agent waits for approval.

alter table public.pending_actions add column send_attempted boolean not null default false;

drop index public.pending_actions_one_reply_per_inbound_idx;
create unique index pending_actions_one_reply_per_inbound_idx
  on public.pending_actions ((payload ->> 'reply_to_uuid'))
  where kind = 'send_reply'
    and (status in ('awaiting', 'approved', 'executing', 'executed') or send_attempted);

alter table public.pending_actions drop constraint pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly', 'launch_campaign', 'assign_leads', 'activate_rule', 'send_reply', 'pause_campaign',
  'resume_campaign', 'create_campaign', 'decide_gate', 'delete_rule', 'crm_close_deal', 'run_actor',
  'update_sequence', 'issue_operator_key', 'remove_leads', 'label_reply'
]));
