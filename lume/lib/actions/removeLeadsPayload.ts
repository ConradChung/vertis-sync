import { z } from 'zod'
import type { Json } from '@/lib/db/types'
import { CAMPAIGN_ID_RE } from '@/lib/rules/schema'

/** remove_leads payload shape shared by the builder (lib/actions/removeLeads.ts) and createAction. Pure. */

export const MAX_REMOVE = 1000
export const LEAD_ID = z.string().regex(/^[A-Za-z0-9-]{1,64}$/)

/** What createAction checks on every remove_leads row (any caller). */
export function removeLeadsPayloadError(p: Record<string, Json>): string | null {
  if (typeof p.campaign_id !== 'string' || !CAMPAIGN_ID_RE.test(p.campaign_id)) return 'payload.campaign_id is required'
  if (!Array.isArray(p.lead_ids) || !p.lead_ids.length || p.lead_ids.length > MAX_REMOVE) return `payload.lead_ids needs 1-${MAX_REMOVE} ids`
  if (!p.lead_ids.every((x) => typeof x === 'string' && LEAD_ID.safeParse(x).success)) return 'payload.lead_ids must be lead ids'
  if (typeof p.count !== 'number') return 'payload.count is required'
  return null
}
