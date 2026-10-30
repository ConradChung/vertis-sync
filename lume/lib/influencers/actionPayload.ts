import type { Json, PendingActionKind } from '@/lib/db/types'

/** Pure checks for the two influencer pending-action kinds (used by createAction). */

export const INFLUENCER_PIPELINE = 'pm_influencer_reactions'

export type InfluencerActionBuild =
  | { ok: true; kind: PendingActionKind; payload: Record<string, Json> & { summary: string } }
  | { ok: false; status: number; error: string }

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** null when the snapshot carries what the executor and the card read. */
export function influencerPayloadError(kind: 'influencer_run' | 'influencer_reactions', p: Record<string, Json>): string | null {
  if (kind === 'influencer_run') {
    if (p.pipeline !== INFLUENCER_PIPELINE) return 'payload.pipeline must be pm_influencer_reactions'
    if (!Array.isArray(p.influencer_ids) || !p.influencer_ids.length || !p.influencer_ids.every((x) => typeof x === 'string' && LOWER_UUID.test(x))) {
      return 'payload.influencer_ids must be lowercase uuids'
    }
    if (typeof p.max_verify_usd !== 'number' || !(p.max_verify_usd > 0) || p.max_verify_usd > 50) return 'payload.max_verify_usd must be in (0, 50]'
    return null
  }
  if (typeof p.run_id !== 'string' || !LOWER_UUID.test(p.run_id)) return 'payload.run_id must be a lowercase uuid'
  if (typeof p.reactions_usd !== 'number' || !(p.reactions_usd >= 0)) return 'payload.reactions_usd is required'
  if (typeof p.max_verify_usd !== 'number' || !(p.max_verify_usd > 0) || p.max_verify_usd > 50) return 'payload.max_verify_usd must be in (0, 50]'
  return null
}

/** One awaiting action per key: one run start at a time, one reactions approval per run. */
export const INFLUENCER_ACTION_KEY = { influencer_run: 'pipeline', influencer_reactions: 'run_id' } as const
