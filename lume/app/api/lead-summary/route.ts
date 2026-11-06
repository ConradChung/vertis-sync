import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { createServiceClient } from '@/lib/supabase/service'
import { shapeSummary, SummaryInput } from '@/lib/leads/summary'

/**
 * `POST /api/lead-summary` `{ set_id, group_by?, metrics?, status?, limit? }`
 * (a review set or a lead list) → group-by counts and count_distinct / sum /
 * avg / min / max over the set's own columns, largest groups first (≤ 100,
 * the rest as `other`). Runs in SQL (lume_summarize_lead_set); no rows move.
 * Owner, or the agent's bearer (summarize_lead_set).
 */
export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, SummaryInput, 16 * 1024)
  if (!body.ok) return body.response
  try {
    const sb = createServiceClient()
    const id = body.data.set_id.toLowerCase()
    const { data: set, error } = await sb.from('lead_review_sets').select('id,title,kind,columns,item_count').eq('id', id).is('archived_at', null).maybeSingle()
    if (error) throw error
    if (!set) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const columns = (Array.isArray(set.columns) ? set.columns : []) as string[]
    const groupBy = body.data.group_by ?? []
    const metrics = body.data.metrics ?? []
    const unknown = [...groupBy, ...metrics.map((m) => m.column)].filter((c) => !columns.includes(c))
    if (unknown.length) return NextResponse.json({ error: 'unknown_columns', unknown, columns }, { status: 400 })
    // A review set's summary is over its kept rows unless asked otherwise; a list has no exclusions.
    const status = body.data.status === 'all' ? null : (body.data.status ?? 'kept')
    const rpc = await sb.rpc('lume_summarize_lead_set', { p_set: id, p_group_by: groupBy, p_metrics: metrics, p_status: status, p_limit: body.data.limit ?? 100 })
    if (rpc.error) throw rpc.error
    return NextResponse.json({ set: { id, title: set.title, kind: set.kind, item_count: set.item_count }, group_by: groupBy, ...shapeSummary(rpc.data, groupBy, metrics) })
  } catch (err) {
    return dbErrorResponse(err, 'api/lead-summary')
  }
}
