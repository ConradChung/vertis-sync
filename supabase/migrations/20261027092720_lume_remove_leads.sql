-- Lume Phase 2: pending_actions.kind += remove_leads (delete leads from an
-- Instantly campaign to free the contact cap) and lume_cycled_leads, the
-- snapshot of every lead removed that way. Replied / interested leads are
-- never removed (enforced by the executor). One awaiting agent/user removal
-- per campaign; rule removals are one-per-rule (pending_actions_one_awaiting_rule_idx).
alter table public.pending_actions drop constraint if exists pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly','launch_campaign','assign_leads','activate_rule','send_reply','pause_campaign',
  'resume_campaign','create_campaign','decide_gate','delete_rule','crm_close_deal','run_actor',
  'update_sequence','issue_operator_key','remove_leads']));
create unique index if not exists pending_actions_one_awaiting_remove_leads_idx
  on public.pending_actions (kind, (payload->>'campaign_id'))
  where status = 'awaiting' and kind = 'remove_leads' and rule_id is null;

create table if not exists public.lume_cycled_leads (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       text not null,
  instantly_lead_id text not null,
  email             text check (email is null or (email = lower(email) and length(email) <= 320)),
  snapshot          jsonb not null,
  reason            text check (reason is null or length(reason) <= 300),
  removed_at        timestamptz not null default now(),
  action_id         uuid references public.pending_actions(id) on delete set null,
  unique (action_id, instantly_lead_id)
);
create index if not exists lume_cycled_leads_campaign_email_idx on public.lume_cycled_leads (campaign_id, email);
create index if not exists lume_cycled_leads_removed_idx on public.lume_cycled_leads (removed_at desc);

-- Like the other lume tables: RLS on, owner-only read, writes via the service role only.
alter table public.lume_cycled_leads enable row level security;
revoke all on public.lume_cycled_leads from anon, authenticated;
grant select on public.lume_cycled_leads to authenticated;
drop policy if exists lume_cycled_leads_owner_read on public.lume_cycled_leads;
create policy lume_cycled_leads_owner_read on public.lume_cycled_leads
  for select to authenticated using ((select lume_is_owner()));
