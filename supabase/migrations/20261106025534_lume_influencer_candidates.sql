-- Influencer LinkedIn lookup: turn a list of names (an attached xlsx / csv)
-- into reviewed `influencers` rows.
--
-- influencer_candidate_batches  one imported list: its source attachment, the
--                               lookup's state (staged -> looking_up -> done |
--                               capped | cancelled | failed), the owner-approved
--                               spend cap and what was spent, and a lease for
--                               the influencer-lookup edge function's chain.
-- influencer_candidates         one person per row: what the list said (name,
--                               title, company, category, notes, source
--                               context), the LinkedIn URL the lookup found
--                               (only from a cited source), its confidence and
--                               evidence, and the review status. influencer_id
--                               is the influencers row it became (approve) or
--                               already is (duplicate).
--
-- The lookup spends money (Perplexity Sonar ~$0.006 per person), so it only
-- runs after the owner approves an `influencer_lookup` pending action.
-- All tables: RLS on, no policies, no grants to anon/authenticated (service role only).

create table public.influencer_candidate_batches (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  source_file_id uuid references public.agent_chat_files(id) on delete set null,
  source_sheet text check (source_sheet is null or length(source_sheet) <= 200),
  conversation_id uuid references public.agent_conversations(id) on delete set null,
  status text not null default 'staged' check (status in ('staged', 'looking_up', 'done', 'capped', 'cancelled', 'failed')),
  max_lookup_usd numeric(10, 4) check (max_lookup_usd is null or (max_lookup_usd > 0 and max_lookup_usd <= 50)),
  spent_usd numeric(10, 4) not null default 0 check (spent_usd >= 0),
  lookup_action_id uuid,
  lease_token uuid,
  lease_until timestamptz,
  error text check (error is null or length(error) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index influencer_candidate_batches_created_idx on public.influencer_candidate_batches (created_at desc);
alter table public.influencer_candidate_batches enable row level security;
revoke all on public.influencer_candidate_batches from anon, authenticated;

create table public.influencer_candidates (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.influencer_candidate_batches(id) on delete cascade,
  row_index int not null check (row_index >= 0),
  name text not null check (length(btrim(name)) between 1 and 200),
  title text check (title is null or length(title) <= 500),
  company text check (company is null or length(company) <= 500),
  category text check (category is null or length(category) <= 500),
  notes text check (notes is null or length(notes) <= 2000),
  source_context text check (source_context is null or length(source_context) <= 2000),
  linkedin_url text check (linkedin_url is null or (linkedin_url ~ '^https://www\.linkedin\.com/in/[^/?#\s]+$' and length(linkedin_url) <= 300)),
  confidence text check (confidence is null or confidence in ('high', 'medium', 'not_found')),
  evidence jsonb check (evidence is null or jsonb_typeof(evidence) = 'object'),
  status text not null default 'pending_lookup' check (status in ('pending_lookup', 'found', 'not_found', 'approved', 'rejected', 'duplicate')),
  influencer_id uuid references public.influencers(id) on delete set null,
  lookup_attempts int not null default 0 check (lookup_attempts >= 0),
  lookup_error text check (lookup_error is null or length(lookup_error) <= 1000),
  lookup_usd numeric(10, 4) not null default 0 check (lookup_usd >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, row_index)
);
create index influencer_candidates_batch_status_idx on public.influencer_candidates (batch_id, status, row_index);
alter table public.influencer_candidates enable row level security;
revoke all on public.influencer_candidates from anon, authenticated;

-- The lookup approval: one awaiting per batch.
alter table public.pending_actions drop constraint if exists pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly', 'launch_campaign', 'assign_leads', 'activate_rule', 'send_reply', 'pause_campaign',
  'resume_campaign', 'create_campaign', 'decide_gate', 'delete_rule', 'crm_close_deal', 'run_actor',
  'update_sequence', 'issue_operator_key', 'remove_leads', 'label_reply',
  'influencer_run', 'influencer_reactions', 'stage_attachment', 'influencer_lookup'
]));
create unique index if not exists pending_actions_one_awaiting_influencer_lookup_idx
  on public.pending_actions (kind, (payload->>'batch_id'))
  where status = 'awaiting' and kind = 'influencer_lookup';

-- Sweep: a lookup whose chain died (lease expired with people still pending)
-- is re-kicked by POSTing {action: 'sweep'} to influencer-lookup every 5
-- minutes (same vault entries project_url + service_role_key as
-- lume_influencer_sweep_tick). Nothing to do: no request. Never raises.
create or replace function public.lume_influencer_lookup_sweep_tick() returns void
language plpgsql security definer
set search_path = pg_catalog, public
set lock_timeout = '2s'
as $$
declare
  key text;
  url text;
begin
  if not exists (select 1 from public.influencer_candidate_batches
                  where status = 'looking_up' and (lease_until is null or lease_until < now())) then
    return;
  end if;
  select decrypted_secret into key from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into url from vault.decrypted_secrets where name = 'project_url';
  if key is null or url is null then return; end if;
  perform net.http_post(
    url     := url || '/functions/v1/influencer-lookup',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || key, 'apikey', key),
    body    := jsonb_build_object('action', 'sweep'));
exception when others then
  raise warning 'lume_influencer_lookup_sweep_tick: %', sqlerrm;
end $$;
revoke all on function public.lume_influencer_lookup_sweep_tick() from public, anon, authenticated;

select cron.unschedule('influencer-lookup-sweep') where exists (
  select 1 from cron.job where jobname = 'influencer-lookup-sweep');
select cron.schedule('influencer-lookup-sweep', '*/5 * * * *', 'select public.lume_influencer_lookup_sweep_tick()');
