import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'
import { currentOperator } from '@/lib/operators/session'
import { createInboxProject } from '@/lib/inbox/seedProject'

/**
 * POST /api/verticals/<id>/inbox-project — "Create Inbox project" (inbox
 * manager 3d): `<vertical> · Inbox`, linked to the vertical, seeded with the
 * five SOP notes (lib/inbox/seedProject.ts). Idempotent: a re-run adds only
 * missing notes and never overwrites one.
 *   201 created · 200 already there (missing notes added) ·
 *   409 vertical_has_project { project } / name_taken · 404 vertical_not_found.
 * Owner (session or the agent's bearer: create_inbox_project is low), the
 * master bot, or a vertical bot for its own vertical only.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_id' }, { status: 400 })
  const op = await currentOperator(req)
  if (op && !op.is_master && op.vertical_id !== id) return NextResponse.json({ error: 'vertical_out_of_scope' }, { status: 403 })
  try {
    const out = await createInboxProject(id)
    if (out.ok) return NextResponse.json(out, { status: out.created_project ? 201 : 200 })
    if (out.error === 'vertical_not_found') return NextResponse.json({ error: out.error }, { status: 404 })
    const { ok: _ok, ...rest } = out
    void _ok
    return NextResponse.json(rest, { status: 409 })
  } catch (err) {
    return dbErrorResponse(err, 'api/verticals/[id]/inbox-project')
  }
}
