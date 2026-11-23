import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { PendingActionRow } from '@/lib/db/types'

/** The most rows the Approvals list loads; `count` is exact beyond it. */
export const PENDING_LIMIT = 200

/** Every awaiting pending action, of every kind, newest first (read only). */
export async function listAwaitingActions(limit = PENDING_LIMIT): Promise<{ rows: PendingActionRow[]; count: number }> {
  const sb = createServiceClient()
  const res = await sb
    .from('pending_actions')
    .select('*', { count: 'exact' })
    .eq('status', 'awaiting')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (res.error) throw new DbError('listAwaitingActions', res.error)
  const rows = (res.data ?? []) as PendingActionRow[]
  return { rows, count: res.count ?? rows.length }
}
