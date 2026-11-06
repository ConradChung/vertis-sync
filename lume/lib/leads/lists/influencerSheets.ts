import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { createList, type LeadList } from '@/lib/leads/lists/store'

/**
 * Influencer candidate batches as sheets in Leads: one lead list per batch
 * (sheet_kind 'influencer_candidates', influencer_batch_id), in the batch
 * chat's project folder (else the Influencers folder). The candidates stay in
 * influencer_candidates, where the lookup engine reads and writes them; the
 * sheet only points at the batch.
 */

/** The sheet for a new batch; filed in its chat's project when it has one. */
export async function createInfluencerSheet(batch: { id: string; name: string }, rows: number, conversationId: string | null): Promise<LeadList> {
  let projectId: string | null = null
  if (conversationId) {
    const { data, error } = await createServiceClient().from('agent_conversations').select('project_id').eq('id', conversationId).maybeSingle()
    if (error) throw error
    projectId = (data?.project_id as string | null) ?? null
  }
  return createList({ name: batch.name, created_by: 'agent', project_id: projectId, sheet_kind: 'influencer_candidates', influencer_batch_id: batch.id, item_count: rows, conversation_id: conversationId })
}

/** batch id → its sheet's list id. */
export async function sheetsForBatches(batchIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!batchIds.length) return out
  const { data, error } = await createServiceClient().from('lead_review_sets').select('id,influencer_batch_id').in('influencer_batch_id', batchIds)
  if (error) throw error
  for (const r of data ?? []) out.set(r.influencer_batch_id as string, r.id as string)
  return out
}
