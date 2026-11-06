import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { createServiceClient } from '@/lib/supabase/service'
import { shapeSummary, SummaryInput } from '@/lib/leads/summary'
import { reviewSetInScope } from '@/lib/leads/lists/reviewRows'
import { ensureCells, type ReviewSet } from '@/lib/review/store'

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
    const { data: found, error } = await sb.from('lead_review_sets').select('id,title,kind,columns,all_columns,item_count').eq('id', id).is('archived_at', null).maybeSingle()
    if (error) throw error
    if (!found) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    // The agent summarises a review set only from its own chat (or its project's chats); lists are the shared workspace.
    if (auth.via === 'internal' && found.kind !== 'list') {
      const conv = body.data.conversation_id?.toLowerCase()
      if (!conv || !(await reviewSetInScope(id, conv, body.data.project_id?.toLowerCase() ?? null))) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    // A review set loaded before cells were stored gets them now.
    const set = found.kind === 'list' ? found : await ensureCells(found as unknown as ReviewSet)
    const shown = (Array.isArray(set.columns) ? set.columns : []) as string[]
    const stored = (Array.isArray(set.all_columns) ? set.all_columns : []) as string[]
    // Any stored column, not only the shown ones.
    const columns = stored.length ? stored : shown
    const groupBy = body.data.group_by ?? []
    const metrics = body.data.metrics ?? []
    const where = body.data.where ?? {}
    const unknown = [...groupBy, ...metrics.map((m) => m.column), ...Object.keys(where)].filter((c) => !columns.includes(c))
    if (unknown.length) return NextResponse.json({ error: 'unknown_columns', unknown, columns }, { status: 400 })
    // A review set's summary is over its kept rows unless asked otherwise; a list has no exclusions.
    const status = body.data.status === 'all' ? null : (body.data.status ?? 'kept')
    const rpc = await sb.rpc('lume_summarize_lead_set', { p_set: id, p_group_by: groupBy, p_metrics: metrics, p_status: status, p_limit: body.data.limit ?? 100, p_where: where })
    if (rpc.error) throw rpc.error
    return NextResponse.json({ set: { id, title: found.title, kind: found.kind, item_count: found.item_count }, group_by: groupBy, where, ...shapeSummary(rpc.data, groupBy, metrics) })
  } catch (err) {
    return dbErrorResponse(err, 'api/lead-summary')
  }
}
