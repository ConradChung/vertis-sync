import 'server-only'
import { z } from 'zod'
import type { Json } from '@/lib/db/types'
import { callInfluencerFn } from '@/lib/adapters/influencerFn'
import { estimateLookup, LOOKUP_CAP_LIMIT_USD, LOOKUP_USD_PER_PERSON } from '@/lib/influencers/candidates'
import { batchCounts, getCandidateBatch } from '@/lib/influencers/candidateStore'
import type { InfluencerActionBuild } from '@/lib/influencers/actionPayload'

/**
 * `influencer_lookup`: the paid LinkedIn lookup of a staged candidate batch
 * (lookup_influencer_candidates). Always asks: it spends Perplexity money.
 *
 *  build    { batch_id, max_usd? } → the people still pending x
 *           LOOKUP_USD_PER_PERSON, and a hard cap (default +25 %, ≤ $50) the
 *           edge function stops at (status 'capped').
 *  execute  re-checks the batch (still staged / capped, people still
 *           pending), then starts influencer-lookup with the approved cap and
 *           this action's id (a retried start for the same id is a no-op).
 */

const fmt = (n: number) => `$${n.toFixed(2)}`
const fail = (status: number, error: string): InfluencerActionBuild => ({ ok: false, status, error })
const uncertainCall = (error: string) => error === 'timeout' || error === 'unreachable'
const STARTABLE = new Set(['staged', 'capped'])

const Body = z.object({ batch_id: z.string().uuid(), max_usd: z.number().positive().max(LOOKUP_CAP_LIMIT_USD).optional() })

export async function buildInfluencerLookup(raw: Record<string, unknown>): Promise<InfluencerActionBuild> {
  const body = Body.safeParse(raw)
  if (!body.success) return fail(400, 'invalid_payload')
  const batchId = body.data.batch_id.toLowerCase()
  const batch = await getCandidateBatch(batchId)
  if (!batch) return fail(404, 'batch_not_found')
  if (batch.status === 'looking_up') return fail(409, 'lookup_running')
  if (!STARTABLE.has(batch.status)) return fail(409, `batch_${batch.status}`)
  const people = (await batchCounts(batchId)).pending_lookup ?? 0
  if (!people) return fail(409, 'nothing_to_look_up')
  const est = estimateLookup(people)
  const cap = body.data.max_usd ?? est.default_cap_usd
  if (cap < LOOKUP_USD_PER_PERSON) return fail(400, `max_usd below one lookup (${fmt(LOOKUP_USD_PER_PERSON)})`)
  return {
    ok: true,
    kind: 'influencer_lookup',
    payload: {
      batch_id: batchId,
      batch_name: batch.name,
      people,
      estimate_usd: est.usd,
      max_usd: cap,
      summary:
        `Look up the LinkedIn profiles of ${people} people in "${batch.name}" with Perplexity Sonar: ~${fmt(est.usd)} (${people} × $${LOOKUP_USD_PER_PERSON}), ` +
        `hard cap ${fmt(cap)} (it stops there). Only cited profiles tied to the person's company or role are kept; ` +
        'you review and approve each one before it becomes an influencer (inactive until you run it).',
    },
  }
}

export type ExecOutcome = { ok: true; result: Record<string, Json> } | { ok: false; error: string; result: Record<string, Json> }

export async function executeInfluencerLookup(p: Record<string, Json>, actionId: string): Promise<ExecOutcome> {
  const batchId = typeof p.batch_id === 'string' ? p.batch_id : ''
  const maxUsd = typeof p.max_usd === 'number' ? p.max_usd : NaN
  if (!batchId || !Number.isFinite(maxUsd)) return { ok: false, error: 'payload.batch_id / max_usd missing', result: {} }
  const batch = await getCandidateBatch(batchId)
  if (!batch) return { ok: false, error: 're-check failed: the batch is gone', result: { batch_id: batchId } }
  if (!STARTABLE.has(batch.status)) return { ok: false, error: `re-check failed: the batch is ${batch.status}`, result: { batch_id: batchId, status: batch.status } }
  const pending = (await batchCounts(batchId)).pending_lookup ?? 0
  if (!pending) return { ok: false, error: 're-check failed: nobody left to look up', result: { batch_id: batchId } }
  const r = await callInfluencerFn({ action: 'start', batch_id: batchId, max_usd: maxUsd, action_id: actionId }, 'influencer-lookup')
  if (!r.ok) {
    return {
      ok: false,
      error: `influencer-lookup start: ${r.error}`,
      result: uncertainCall(r.error)
        ? { http_status: r.status, uncertain: true, note: 'The lookup may have started: check list_influencer_candidates before retrying.' }
        : { http_status: r.status },
    }
  }
  return { ok: true, result: { batch_id: batchId, status: 'looking_up', max_lookup_usd: typeof r.body.max_lookup_usd === 'number' ? r.body.max_lookup_usd : maxUsd } }
}
