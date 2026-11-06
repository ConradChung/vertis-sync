import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import { planApproval, type PlannedCandidate, type ReviewCandidate } from '@/lib/influencers/candidates'
import { DuplicateInfluencerError, insertInfluencer } from '@/lib/influencers/store'

/**
 * `influencer_candidate_batches` / `influencer_candidates` (service role,
 * behind the owner guard). Staging and review only: nothing here spends; the
 * lookup runs in the influencer-lookup edge function after the owner approves
 * an `influencer_lookup` pending action.
 */

export interface CandidateBatch {
  id: string
  name: string
  source_file_id: string | null
  source_sheet: string | null
  conversation_id: string | null
  status: 'staged' | 'looking_up' | 'done' | 'capped' | 'cancelled' | 'failed'
  max_lookup_usd: number | string | null
  spent_usd: number | string
  error: string | null
  created_at: string
  updated_at: string
}

export interface CandidateRow extends ReviewCandidate {
  batch_id: string
  row_index: number
  notes: string | null
  source_context: string | null
  confidence: 'high' | 'medium' | 'not_found' | null
  evidence: { url?: string; snippet?: string } | null
  influencer_id: string | null
  lookup_attempts: number
  lookup_error: string | null
  updated_at: string
}

const BATCH_COLS = 'id,name,source_file_id,source_sheet,conversation_id,status,max_lookup_usd,spent_usd,error,created_at,updated_at'
const CAND_COLS =
  'id,batch_id,row_index,name,title,company,category,notes,source_context,linkedin_url,confidence,evidence,status,influencer_id,lookup_attempts,lookup_error,updated_at'
const db = () => createServiceClient()

export async function createCandidateBatch(
  meta: { name: string; source_file_id: string | null; source_sheet: string | null; conversation_id: string | null },
  rows: PlannedCandidate[]
): Promise<CandidateBatch> {
  const sb = db()
  const b = await sb.from('influencer_candidate_batches').insert(meta).select(BATCH_COLS).single()
  if (b.error || !b.data) throw new DbError('createCandidateBatch', b.error ?? new Error('no data'))
  const batch = b.data as CandidateBatch
  for (let i = 0; i < rows.length; i += 500) {
    const res = await sb.from('influencer_candidates').insert(rows.slice(i, i + 500).map((r) => ({ ...r, batch_id: batch.id })))
    if (res.error) {
      await sb.from('influencer_candidate_batches').delete().eq('id', batch.id)
      throw new DbError('createCandidateBatch.rows', res.error)
    }
  }
  return batch
}

export async function getCandidateBatch(id: string): Promise<CandidateBatch | null> {
  const res = await db().from('influencer_candidate_batches').select(BATCH_COLS).eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getCandidateBatch', res.error)
  return (res.data as CandidateBatch | null) ?? null
}

export type StatusCounts = Record<string, number>

/** Newest batches with their per-status counts. */
export async function listCandidateBatches(limit = 20): Promise<(CandidateBatch & { counts: StatusCounts })[]> {
  const sb = db()
  const res = await sb.from('influencer_candidate_batches').select(BATCH_COLS).order('created_at', { ascending: false }).limit(limit)
  if (res.error) throw new DbError('listCandidateBatches', res.error)
  const batches = (res.data ?? []) as CandidateBatch[]
  const counts = await countByStatus(batches.map((b) => b.id))
  return batches.map((b) => ({ ...b, counts: counts.get(b.id) ?? {} }))
}

async function countByStatus(batchIds: string[]): Promise<Map<string, StatusCounts>> {
  const out = new Map<string, StatusCounts>()
  if (!batchIds.length) return out
  for (let from = 0; ; from += 1000) {
    const res = await db().from('influencer_candidates').select('batch_id,status').in('batch_id', batchIds).order('id').range(from, from + 999)
    if (res.error) throw new DbError('countByStatus', res.error)
    for (const r of (res.data ?? []) as { batch_id: string; status: string }[]) {
      const c = out.get(r.batch_id) ?? {}
      c[r.status] = (c[r.status] ?? 0) + 1
      out.set(r.batch_id, c)
    }
    if (!res.data || res.data.length < 1000) break
  }
  return out
}

export async function batchCounts(batchId: string): Promise<StatusCounts> {
  return (await countByStatus([batchId])).get(batchId) ?? {}
}

/** A batch's candidates in list order (≤ 5,000), optionally one status. */
export async function listCandidates(batchId: string, status?: string): Promise<CandidateRow[]> {
  const out: CandidateRow[] = []
  for (let from = 0; from < 5000; from += 1000) {
    let q = db().from('influencer_candidates').select(CAND_COLS).eq('batch_id', batchId)
    if (status) q = q.eq('status', status)
    const res = await q.order('row_index').range(from, from + 999)
    if (res.error) throw new DbError('listCandidates', res.error)
    out.push(...((res.data ?? []) as CandidateRow[]))
    if (!res.data || res.data.length < 1000) break
  }
  return out
}

export async function getCandidatesByIds(ids: string[]): Promise<CandidateRow[]> {
  if (!ids.length) return []
  const res = await db().from('influencer_candidates').select(CAND_COLS).in('id', ids)
  if (res.error) throw new DbError('getCandidatesByIds', res.error)
  return (res.data ?? []) as CandidateRow[]
}

async function existingInfluencerKeys(): Promise<{ id: string; slug: string; linkedin_url: string }[]> {
  const res = await db().from('influencers').select('id,slug,linkedin_url').limit(10_000)
  if (res.error) throw new DbError('existingInfluencerKeys', res.error)
  return (res.data ?? []) as { id: string; slug: string; linkedin_url: string }[]
}

/** Names of existing influencers, for the import's duplicate check. */
export async function existingInfluencerNames(): Promise<{ id: string; name: string }[]> {
  const res = await db().from('influencers').select('id,name').limit(10_000)
  if (res.error) throw new DbError('existingInfluencerNames', res.error)
  return (res.data ?? []) as { id: string; name: string }[]
}

const nowIso = () => new Date().toISOString()

/**
 * Approve: each 'found' candidate becomes an INACTIVE influencers row (or is
 * linked to the existing one with that profile) and is marked approved with
 * its influencer_id. Only rows still 'found' change, so a double click is a
 * no-op. Nothing runs: the owner activates influencers and starts a run later.
 */
export async function approveCandidates(ids: string[]) {
  const cands = await getCandidatesByIds(ids)
  const plan = planApproval(cands, await existingInfluencerKeys())
  const sb = db()
  const approved: { candidate_id: string; influencer_id: string; created: boolean }[] = []
  const skipped = [...plan.skipped]
  const mark = async (candidateId: string, influencerId: string, status: 'approved' | 'duplicate') => {
    const res = await sb.from('influencer_candidates').update({ status, influencer_id: influencerId, updated_at: nowIso() }).eq('id', candidateId).eq('status', 'found').select('id')
    if (res.error) throw new DbError('approveCandidates.mark', res.error)
    return (res.data ?? []).length > 0
  }
  for (const l of plan.link) {
    if (await mark(l.candidate_id, l.influencer_id, 'duplicate')) approved.push({ ...l, created: false })
  }
  for (const c of plan.create) {
    try {
      const row = await insertInfluencer(c.influencer)
      if (await mark(c.candidate_id, row.id, 'approved')) approved.push({ candidate_id: c.candidate_id, influencer_id: row.id, created: true })
    } catch (err) {
      if (err instanceof DuplicateInfluencerError) skipped.push({ candidate_id: c.candidate_id, reason: 'an influencer with this slug or profile was added meanwhile; approve again' })
      else throw err
    }
  }
  return { approved, skipped }
}

/** Reject: the candidate stays in the batch as rejected (never becomes an influencer). */
export async function rejectCandidates(ids: string[]): Promise<number> {
  if (!ids.length) return 0
  const res = await db()
    .from('influencer_candidates')
    .update({ status: 'rejected', updated_at: nowIso() })
    .in('id', ids)
    .in('status', ['found', 'not_found', 'pending_lookup'])
    .select('id')
  if (res.error) throw new DbError('rejectCandidates', res.error)
  return (res.data ?? []).length
}
