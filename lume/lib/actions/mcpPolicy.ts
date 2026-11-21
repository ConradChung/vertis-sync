import type { PendingActionKind } from '@/lib/db/types'

/**
 * What the Lume MCP server (lib/mcp) may do with pending actions. Lives with
 * the action core so createAction and claimDecision enforce it for every
 * caller, not only the MCP tools.
 */

/** The only kinds a `requested_by = 'mcp'` row may have: one per MCP gated tool. */
export const MCP_CREATABLE_KINDS: ReadonlySet<PendingActionKind> = new Set<PendingActionKind>([
  'new_campaign', // lume_create_campaign
  'create_campaign', // lume_duplicate_campaign
  'update_sequence', // lume_update_sequence
  'push_to_instantly', // lume_push_to_instantly
  'send_lead_list', // lume_run_validation
  'pause_campaign', // lume_pause_campaign
  'resume_campaign', // lume_resume_campaign
  'assign_leads', // lume_assign_leads
  'influencer_run', // lume_run_influencer_scrape
  'influencer_reactions', // lume_run_influencer_reactions
  'influencer_lookup', // lume_run_influencer_lookup
])

/**
 * Kinds MCP may ever confirm itself. A ceiling in code: the runtime allowlist
 * (LUME_MCP_CONFIRM_KINDS) can only narrow it, never widen it.
 */
export const MCP_CONFIRM_CEILING: ReadonlySet<PendingActionKind> = new Set<PendingActionKind>(['pause_campaign', 'resume_campaign'])

/** Never decide an MCP-requested row through these: a person (dashboard, Telegram) or MCP's own confirm only. */
export const MCP_FORBIDDEN_DECIDERS: ReadonlySet<string> = new Set(['grant', 'agent'])

export class McpKindNotAllowedError extends Error {
  constructor(kind: string) {
    super(`kind_not_allowed_for_mcp: ${kind}`)
    this.name = 'McpKindNotAllowedError'
  }
}
