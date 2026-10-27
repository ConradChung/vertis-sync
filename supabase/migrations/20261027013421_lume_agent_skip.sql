-- Skip-permissions mode approves on the owner's behalf; record it distinctly.
alter table pending_actions drop constraint if exists pending_actions_decided_via_check;
alter table pending_actions add constraint pending_actions_decided_via_check check (decided_via in ('lume','telegram','agent'));
-- Automatic follow-up turns (approval outcomes) render as a compact line, not a user bubble.
alter table agent_messages add column if not exists auto boolean not null default false;
