import { NextResponse } from 'next/server'
import { requireOwnerSession } from '@/lib/auth/guards'
import { decideHiringRow } from '@/lib/hiring/store'

/**
 * GTM-19 sheet decision: `{ "decision": "sent" | "skipped" }` moves a row
 * from new once (conditional update), recording who decided. The owner's own
 * session only (the agent never marks an email sent). 409 when the row was
 * already decided: a double click is a no-op.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const { id: raw } = await ctx.params
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: 'bad_id' }, { status: 400 })
  let decision: unknown
  try {
    decision = ((await req.json()) as { decision?: unknown } | null)?.decision
  } catch {
    return NextResponse.json({ error: 'bad_body' }, { status: 400 })
  }
  if (decision !== 'sent' && decision !== 'skipped') return NextResponse.json({ error: 'decision must be sent or skipped' }, { status: 400 })
  try {
    const row = await decideHiringRow(id, decision, auth.user.email ?? 'owner')
    if (!row) return NextResponse.json({ error: 'already_decided' }, { status: 409 })
    return NextResponse.json({ row })
  } catch (err) {
    console.error('[api/signals/hiring/:id] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'hiring_decide_failed' }, { status: 500 })
  }
}
