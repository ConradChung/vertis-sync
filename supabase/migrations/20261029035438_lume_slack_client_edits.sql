-- Inbox manager 3g follow-up: a client's Slack Edit is drafting, not approving.
-- pending_actions.edited_by_slack_user records the Slack user whose Edit is the
-- current body of an awaiting send_reply; the app refuses an approval by that
-- same user (owner, another client user or the master bot approves instead).
-- Cleared when anyone else edits the body.
alter table public.pending_actions
  add column edited_by_slack_user text check (edited_by_slack_user is null or edited_by_slack_user ~ '^[UW][A-Z0-9]{2,30}$');
comment on column public.pending_actions.edited_by_slack_user is
  '3g: Slack user whose Edit is the current send_reply body; that user may not approve it (lume/lib/slack/decide.ts).';
