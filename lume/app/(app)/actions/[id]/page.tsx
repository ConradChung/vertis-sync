import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PageHead } from '@/components/shell/PageHead'
import { ActionPlan, type ActionView } from '@/components/actions/ActionPlan'
import { getAction } from '@/lib/actions/store'
import { requireOwner } from '@/lib/auth/guards'
import { uuidParam } from '@/lib/http/json'
import type { Json } from '@/lib/db/types'

export const metadata: Metadata = { title: 'Confirm action' }
export const dynamic = 'force-dynamic'

/** Payload fields worth showing; the lead list and reply body are summarised. */
function details(payload: Record<string, Json>): [string, string][] {
  const out: [string, string][] = []
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (k === 'summary') continue
    if (k === 'leads' && Array.isArray(v)) {
      out.push(['leads', `${v.length} rows`])
      continue
    }
    if (v === null || typeof v === 'object') continue
    const s = String(v)
    out.push([k, s.length > 400 ? `${s.slice(0, 400)}…` : s])
  }
  return out
}

/** The deep-link target of every pending-action prompt: `/actions/<id>`. */
export default async function ActionPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner()
  if (!auth.ok) notFound()
  const id = uuidParam((await params).id)
  if (!id) notFound()
  const row = await getAction(id)
  if (!row) notFound()

  const view: ActionView = {
    id: row.id,
    kind: row.kind,
    summary: typeof row.payload?.summary === 'string' ? row.payload.summary : row.kind,
    details: details(row.payload),
    requestedBy: row.requested_by,
    status: row.status,
    decidedVia: row.decided_via,
    decidedAt: row.decided_at,
    executedAt: row.executed_at,
    createdAt: row.created_at,
    error: row.error,
  }

  return (
    <>
      <PageHead eyebrow="Pending action" title="Confirm action" sub="Nothing runs until you press Confirm — here or in Telegram." />
      <ActionPlan action={view} />
    </>
  )
}
