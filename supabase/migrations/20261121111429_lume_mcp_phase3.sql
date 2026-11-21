-- Lume MCP server, phase 3: retry cap for the approved-row sweeper, and a
-- database backstop for "an MCP-requested action is never decided by a grant
-- or by the agent", and for pause-only MCP confirm. Additive: one column with
-- a default, two CHECKs every existing row already satisfies (no row has
-- requested_by = 'mcp' or decided_via = 'mcp' today).
-- Phase 3 code reads dispatch_attempts, so apply this before deploying it.

-- 1. Sweeper retry cap: lib/actions/execute.ts counts each re-send here and
--    fails the row as 'not_executed' after MAX_DISPATCH_ATTEMPTS (4).
alter table public.pending_actions
  add column if not exists dispatch_attempts integer not null default 0
  check (dispatch_attempts >= 0);

-- 2. Backstop for lib/actions/store.ts claimDecision's guard.
alter table public.pending_actions
  add constraint pending_actions_mcp_decider_check
  check (requested_by is distinct from 'mcp' or decided_via is null or decided_via not in ('grant', 'agent'));

-- 3. Backstop for pause-only MCP confirm (lib/actions/mcpPolicy.ts
--    MCP_CONFIRM_CEILING). MCP decides a row in exactly two ways, both on rows
--    it requested itself:
--      lume_confirm_action → claimDecision(id, true, 'mcp'):  status approved
--        (then executing → executed | failed), pause_campaign only;
--      lume_cancel_action  → claimDecision(id, false, 'mcp'): status rejected,
--        any MCP kind, and a rejected row never changes status again.
alter table public.pending_actions
  add constraint pending_actions_mcp_confirm_check
  check (decided_via is distinct from 'mcp' or (requested_by = 'mcp' and (kind = 'pause_campaign' or status = 'rejected')));

