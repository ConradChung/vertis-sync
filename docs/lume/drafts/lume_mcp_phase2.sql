-- Lume MCP server, phase 2: attribution for MCP writes, idempotency, and
-- keeping MCP audit rows out of the Overview feed. Additive only: every
-- change widens a CHECK or adds a nullable column / new table. No data moves.

-- 1. Approval queue: MCP can request and decide actions (phase 3 uses these).
alter table public.pending_actions drop constraint pending_actions_requested_by_check;
alter table public.pending_actions add constraint pending_actions_requested_by_check
  check (requested_by = any (array['user','agent','rule','mcp']));

alter table public.pending_actions drop constraint pending_actions_decided_via_check;
alter table public.pending_actions add constraint pending_actions_decided_via_check
  check (decided_via = any (array['lume','telegram','agent','operator','grant','client','mcp']));

alter table public.pending_actions drop constraint pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check
  check (kind = any (array[
    'push_to_instantly','launch_campaign','assign_leads','activate_rule','send_reply',
    'pause_campaign','resume_campaign','create_campaign','decide_gate','delete_rule',
    'crm_close_deal','run_actor','update_sequence','issue_operator_key','remove_leads',
    'label_reply','influencer_run','influencer_reactions','stage_attachment',
    'influencer_lookup','influencer_approve','send_lead_list','delete_lead_list',
    'remove_lead_rows','new_campaign','company_check','bank_queue',
    'rotate_now'
  ]));

-- 2. Attribution: every MCP write says so on the row it touches.
-- Alerts: who acked was only `acked_by_operator`; add where it was acked.
-- Null = an existing path (dashboard, operator, reply inbox); 'mcp' = an agent via MCP.
alter table public.lume_alerts add column if not exists acked_via text
  check (acked_via is null or acked_via = any (array['mcp']));

-- CRM: stage moves and notes from MCP carry source 'mcp'.
alter table public.crm_activities drop constraint crm_activities_source_check;
alter table public.crm_activities add constraint crm_activities_source_check
  check (source = any (array['instantly','gmail','muse','user','agent','mcp']));

-- Tasks created via MCP.
alter table public.lume_tasks drop constraint lume_tasks_created_by_check;
alter table public.lume_tasks add constraint lume_tasks_created_by_check
  check (created_by = any (array['owner','agent','mcp']));

-- Lead lists built via MCP, and their rows.
alter table public.lead_review_sets drop constraint lead_review_sets_created_by_check;
alter table public.lead_review_sets add constraint lead_review_sets_created_by_check
  check (created_by is null or created_by = any (array['agent','owner','mcp']));

alter table public.lead_review_items drop constraint lead_review_items_source_check;
alter table public.lead_review_items add constraint lead_review_items_source_check
  check (source is null or source = any (array['attachment','actor_run','review_set','influencer_export','manual','agent','mcp']));

-- 3. Idempotency: a repeated write with the same key returns the first result.
create table if not exists public.lume_mcp_idempotency (
  key        text primary key check (length(key) between 8 and 200),
  tool       text not null check (tool ~ '^lume_[a-z_]+$'),
  args_hash  text not null check (length(args_hash) = 64),
  result     jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists lume_mcp_idempotency_created_idx on public.lume_mcp_idempotency (created_at);
alter table public.lume_mcp_idempotency enable row level security;
-- No policies: only the service role (server) reads or writes it.
revoke all on public.lume_mcp_idempotency from anon, authenticated;

-- Keys older than 7 days are dropped with the existing daily housekeeping window.
select cron.schedule('lume-mcp-idempotency-purge', '17 4 * * *',
  $$delete from public.lume_mcp_idempotency where created_at < now() - interval '7 days'$$);

-- 4. Overview feed: MCP audit rows (type mcp.tool_call) never show in
-- recent_events and never move the events_last_at canary.
create or replace function public.lume_overview()
 returns json
 language sql
 stable security definer
 set search_path to 'pg_catalog', 'public'
as $function$
  select json_build_object(
    'now', now(),
    'pending_gates', (select count(*) from lume_gates),
    'replies_today', (select count(*) from events where type = 'reply'
                        and created_at > (date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles')),
    'bounces_24h', (select count(*) from events where type = 'bounce' and created_at > now() - interval '24 hours'),
    'active_jobs', (select count(*) from validation_jobs where status in ('pending','processing')),
    'lead_bank_queued', (select count(*) from lead_bank where state = 'queued'),
    'crm_followups_due', (select count(*) from lume_crm_followups),
    -- canary: should move whenever a watched column changes anywhere (MCP audit rows excluded)
    'events_last_at', (select max(created_at) from events where type <> 'mcp.tool_call'),
    'recent_events', (select coalesce(json_agg(e order by e.created_at desc), '[]'::json)
                      from (select * from events where type <> 'mcp.tool_call' order by created_at desc limit 50) e)
  );
$function$;
