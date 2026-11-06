import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import type { LeadItem } from '@/lib/review/model'
import { REVIEW_MAX_ITEMS } from '@/lib/review/model'

/** A review set's kept rows (≤ 5 000, paged), with their raw record, for an append to a list. */
type Kept = { item: LeadItem; raw: Record<string, unknown> | null; cells: Record<string, string> | null }
export async function keptRows(setId: string): Promise<Kept[]> {
  const out: Kept[] = []
  for (let from = 0; from < REVIEW_MAX_ITEMS; from += 1000) {
    const { data, error } = await createServiceClient()
      .from('lead_review_items')
      .select('item,raw,cells')
      .eq('set_id', setId)
      .eq('status', 'kept')
      .order('idx')
      .range(from, from + 999)
    if (error) throw error
    out.push(...((data ?? []) as unknown as Kept[]))
    if (!data || data.length < 1000) break
  }
  return out
}
