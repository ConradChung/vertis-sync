-- Lume Agent chat: spreadsheet attachments (.xlsx / .csv). Additive.
-- The browser uploads the source file straight to Storage with a one-time
-- signed upload URL (files go up to 10 MB, over Vercel's 4.5 MB body cap);
-- POST /api/agent/files then checks the magic bytes, parses it (zip-bomb,
-- sheet and cell caps) and stores the parsed tables next to it as gzipped
-- JSON. Service role only: no storage.objects policies, RLS on with no
-- policies on the table, so anon / authenticated reach nothing.
create table if not exists public.agent_chat_files (
  id uuid primary key,
  name text not null check (char_length(name) between 1 and 200),
  kind text not null check (kind in ('xlsx', 'csv')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  storage_path text not null unique,
  parsed_path text not null unique,
  sheets jsonb not null check (jsonb_typeof(sheets) = 'array'),
  summary text not null check (char_length(summary) <= 30000),
  created_at timestamptz not null default now()
);
alter table public.agent_chat_files enable row level security;
revoke all on public.agent_chat_files from anon, authenticated;

-- Source files (≤ 10 MB) and their parsed tables (gzipped JSON) share the bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('agent-chat-files', 'agent-chat-files', false, 20971520,
        array['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/gzip'])
on conflict (id) do nothing;

-- Project files accept .xlsx too.
update storage.buckets
   set allowed_mime_types = array(select distinct unnest(allowed_mime_types || array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']))
 where id = 'agent-projects' and allowed_mime_types is not null
   and not ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' = any (allowed_mime_types));

-- A sheet of an attachment can become a lead review set.
alter table public.lead_review_sets drop constraint if exists lead_review_sets_source_kind_check;
alter table public.lead_review_sets add constraint lead_review_sets_source_kind_check
  check (source_kind in ('dataset', 'run', 'job', 'attachment'));

-- stage_attachment: the agent's approval to send one sheet to the ingest gate
-- (the Import CSV path). One awaiting per file + sheet.
alter table public.pending_actions drop constraint if exists pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly', 'launch_campaign', 'assign_leads', 'activate_rule', 'send_reply', 'pause_campaign',
  'resume_campaign', 'create_campaign', 'decide_gate', 'delete_rule', 'crm_close_deal', 'run_actor',
  'update_sequence', 'issue_operator_key', 'remove_leads', 'label_reply',
  'influencer_run', 'influencer_reactions', 'stage_attachment'
]));
create unique index if not exists pending_actions_one_awaiting_stage_attachment_idx
  on public.pending_actions (kind, (payload->>'attachment_key'))
  where status = 'awaiting' and kind = 'stage_attachment';
