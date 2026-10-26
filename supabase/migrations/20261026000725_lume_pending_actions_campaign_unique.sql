-- One awaiting pause/resume per campaign, one awaiting send_reply per message.
-- Backs the app-level dedupe in lume/lib/actions/create.ts (23505 -> 409 duplicate).
create unique index if not exists pending_actions_one_awaiting_campaign_idx
  on public.pending_actions (kind, (payload->>'campaign_id'))
  where status = 'awaiting' and kind in ('pause_campaign', 'resume_campaign');

create unique index if not exists pending_actions_one_awaiting_reply_idx
  on public.pending_actions (kind, (payload->>'reply_to_uuid'))
  where status = 'awaiting' and kind = 'send_reply';
