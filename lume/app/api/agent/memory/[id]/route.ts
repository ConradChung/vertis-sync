import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { archiveMemory } from '@/lib/agent/memory'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'

/** `DELETE /api/agent/memory/<id>` — forget one memory (soft delete). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  try {
    return (await archiveMemory(id)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not_found' }, { status: 404 })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/memory/[id]')
  }
}
