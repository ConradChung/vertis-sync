-- Lume Leads: persistent, named lead lists. A list is a lead_review_sets row
-- with kind = 'list' (same tables, same RLS: service role only), never archived
-- automatically, filed in a folder = an agent project (project_id; null =
-- Unfiled). A project's auto-append target is its project_default list.
-- Items carry the source they came from and dedupe keys (email, then LinkedIn,
-- then normalised name + company/domain) so an append dedupes with indexed
-- lookups instead of loading the list. Additive.
alter table public.lead_review_sets
  add column if not exists kind text not null default 'review' check (kind in ('review', 'list')),
  add column if not exists notes text check (notes is null or length(notes) <= 4000),
  add column if not exists created_by text check (created_by is null or created_by in ('agent', 'owner')),
  add column if not exists project_id uuid references public.agent_projects(id) on delete set null,
  add column if not exists project_default boolean not null default false,
  add column if not exists email_count integer not null default 0 check (email_count >= 0),
  -- Send to validator: the CSV ingest it went to (telegram_ingests.id; the job is that ingest's validation_job_id once approved).
  add column if not exists sent_ingest_id uuid references public.telegram_ingests(id) on delete set null,
  add column if not exists sent_at timestamptz,
  add column if not exists sent_rows integer;

alter table public.lead_review_sets drop constraint if exists lead_review_sets_source_kind_check;
alter table public.lead_review_sets add constraint lead_review_sets_source_kind_check
  check (source_kind in ('dataset', 'run', 'job', 'attachment', 'list'));

create unique index if not exists lead_lists_project_default_idx
  on public.lead_review_sets (project_id) where kind = 'list' and project_default and archived_at is null;
create index if not exists lead_lists_folder_idx
  on public.lead_review_sets (project_id, updated_at desc) where kind = 'list' and archived_at is null;

alter table public.lead_review_items
  add column if not exists source text check (source is null or source in ('attachment', 'actor_run', 'review_set', 'influencer_export', 'manual', 'agent')),
  add column if not exists email_key text,
  add column if not exists linkedin_key text,
  add column if not exists name_key text;
create index if not exists lead_review_items_email_key_idx on public.lead_review_items (set_id, email_key) where email_key is not null;
create index if not exists lead_review_items_linkedin_key_idx on public.lead_review_items (set_id, linkedin_key) where linkedin_key is not null;
create index if not exists lead_review_items_name_key_idx on public.lead_review_items (set_id, name_key) where name_key is not null;

-- send_lead_list (the agent's send_lead_list_to_validation) and delete_lead_list: always-ask approvals.
alter table public.pending_actions drop constraint if exists pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly', 'launch_campaign', 'assign_leads', 'activate_rule', 'send_reply', 'pause_campaign', 'resume_campaign',
  'create_campaign', 'decide_gate', 'delete_rule', 'crm_close_deal', 'run_actor', 'update_sequence', 'issue_operator_key',
  'remove_leads', 'label_reply', 'influencer_run', 'influencer_reactions', 'stage_attachment', 'influencer_lookup',
  'influencer_approve', 'send_lead_list', 'delete_lead_list'
]::text[]));
