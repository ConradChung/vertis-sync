/**
 * Grok Bot operator layer: verticals (lines of business) and the operator
 * keys their bots sign in with. Shapes mirror supabase/migrations/
 * 20261027015910_lume_operators.sql.
 */

export const VERTICAL_SCOPES = ['campaign', 'orders', 'replies', 'validation'] as const
export type VerticalScope = (typeof VERTICAL_SCOPES)[number]

export interface Vertical {
  id: string
  name: string
  campaign_ids: string[]
  scopes: VerticalScope[]
  is_default: boolean
  created_at: string
  archived_at: string | null
}

/** A key row; `key_hash` never leaves the server. */
export interface Operator {
  id: string
  vertical_id: string | null
  is_master: boolean
  label: string
  created_at: string
  revoked_at: string | null
  last_seen_at: string | null
}
