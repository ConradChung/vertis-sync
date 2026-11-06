-- Lead lists review fixes.
-- content_changed_at moves only when rows are added, removed or edited (not on
-- a recount), so the resend guard (sent_at < content_changed_at) cannot be
-- reopened by an all-duplicate append or a remove of 0 rows.
alter table public.lead_review_sets
  add column if not exists content_changed_at timestamptz not null default now(),
  -- Appends to one list are serialised with this lease (claimed by a conditional UPDATE).
  add column if not exists append_lease_token uuid,
  add column if not exists append_lease_until timestamptz;
update public.lead_review_sets set content_changed_at = updated_at where kind = 'list';

-- Backstop for the lease: one row per email / LinkedIn per list.
drop index if exists public.lead_review_items_email_key_idx;
drop index if exists public.lead_review_items_linkedin_key_idx;
create unique index if not exists lead_review_items_set_email_key_uniq on public.lead_review_items (set_id, email_key) where email_key is not null;
create unique index if not exists lead_review_items_set_linkedin_key_uniq on public.lead_review_items (set_id, linkedin_key) where linkedin_key is not null;

-- remove_lead_rows: the agent's bulk removal from a list (q, missing, or > 25 rows) always asks.
alter table public.pending_actions drop constraint if exists pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly', 'launch_campaign', 'assign_leads', 'activate_rule', 'send_reply', 'pause_campaign', 'resume_campaign',
  'create_campaign', 'decide_gate', 'delete_rule', 'crm_close_deal', 'run_actor', 'update_sequence', 'issue_operator_key',
  'remove_leads', 'label_reply', 'influencer_run', 'influencer_reactions', 'stage_attachment', 'influencer_lookup',
  'influencer_approve', 'send_lead_list', 'delete_lead_list', 'remove_lead_rows'
]::text[]));
