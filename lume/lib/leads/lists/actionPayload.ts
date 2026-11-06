import type { Json } from '@/lib/db/types'

/** Pure checks for the send_lead_list / delete_lead_list pending actions (used by createAction). */

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** One awaiting send / delete per list (createAction's findAwaitingActionBy). */
export const LEAD_LIST_KEY = 'list_id'

export function leadListPayloadError(p: Record<string, Json>): string | null {
  if (typeof p.list_id !== 'string' || !LOWER_UUID.test(p.list_id)) return 'payload.list_id must be a lowercase uuid'
  if (typeof p.name !== 'string' || !p.name) return 'payload.name is required'
  if (typeof p.rows !== 'number' || !Number.isInteger(p.rows) || p.rows < 0) return 'payload.rows must be a non-negative integer'
  return null
}
