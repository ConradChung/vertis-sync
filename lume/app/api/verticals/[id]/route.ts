import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'
import { archiveVertical, updateVertical } from '@/lib/operators/store'
import { verticalConflict, VerticalFields } from '@/lib/operators/verticalSchema'

/**
 * PATCH one live vertical: `{ name?, scopes?, campaign_ids?, is_default? }`
 * → `{ vertical }`, or `{ archived: true }` alone → `{ archived: true }`.
 * 404 when missing or already archived; 409 duplicate_name / default_taken.
 * Owner (session or the agent's internal bearer: update_vertical is low).
 */

const Body = z.union([
  z.object({ archived: z.literal(true) }).strict(),
  z
    .object({
      name: VerticalFields.name.optional(),
      scopes: VerticalFields.scopes.optional(),
      campaign_ids: VerticalFields.campaign_ids.optional(),
      is_default: VerticalFields.is_default.optional(),
    })
    .strict()
    .refine((b) => Object.keys(b).length > 0),
])

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_id' }, { status: 400 })
  const body = await parseJsonBody(req, Body, 8 * 1024)
  if (!body.ok) return body.response
  try {
    if ('archived' in body.data) {
      return (await archiveVertical(id)) ? NextResponse.json({ archived: true }) : NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    const vertical = await updateVertical(id, body.data)
    return vertical ? NextResponse.json({ vertical }) : NextResponse.json({ error: 'not_found' }, { status: 404 })
  } catch (err) {
    return verticalConflict(err) ?? dbErrorResponse(err, 'api/verticals/[id]')
  }
}
