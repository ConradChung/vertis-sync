import 'server-only'
import { getCampaignDetail, sourceHash } from '@/lib/adapters/instantlyWrite'
import type { PendingActionRow } from '@/lib/db/types'

/**
 * The approval card's warning for a duplicate (create_campaign): the copy
 * takes the source as it is at approval, so say so when the source's inboxes,
 * window, cap, sequence or stop-on-reply changed since the request. After it
 * ran, the result records the same comparison. Never throws: a card renders
 * without the check rather than failing.
 */
export async function duplicateNotices(row: Pick<PendingActionRow, 'kind' | 'status' | 'payload' | 'result'>): Promise<string[]> {
  if (row.kind !== 'create_campaign') return []
  const asked = typeof row.payload?.source_hash === 'string' ? row.payload.source_hash : null
  const result = (row.result ?? null) as Record<string, unknown> | null
  if (result && typeof result.source_changed === 'boolean') {
    return result.source_changed ? ['The source campaign had changed between the request and the copy; the copy took the source as it was at approval.'] : []
  }
  if (row.status !== 'awaiting') return []
  if (!asked) return ['This request has no source fingerprint, so a change to the source since the request cannot be detected. The copy will take the source as it is when you confirm.']
  const id = typeof row.payload?.source_campaign_id === 'string' ? row.payload.source_campaign_id : ''
  try {
    const now = sourceHash(await getCampaignDetail(id))
    return now === asked
      ? []
      : ['The source campaign changed since this was requested (inboxes, schedule, daily limit, sequence or stop-on-reply). Confirm copies it as it is now, not as it was when requested.']
  } catch {
    return ['Could not read the source campaign to check for changes. The copy will take the source as it is when you confirm.']
  }
}
