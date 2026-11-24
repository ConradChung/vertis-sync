import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { FinalFilter } from '@/lib/leads/finalFilter'
import { leadsHref, leadsOnly, sourceErrorResponse, withList, type ListCtx } from '@/lib/leads/lists/service'
import { makeFinal, previewFinal, StageRefused } from '@/lib/leads/lists/stages'

/**
 * Step 3 · Filtered (GTM-18). POST `{ filter, name?, preview? }` on a list:
 *  - `preview: true` → `{ kept, excluded, reasons }` (nothing written);
 *  - otherwise → 201 `{ list, href, kept, excluded, reasons, append }`: a new
 *    final sheet (rows at 3 · Filtered, the dropped ones excluded with their
 *    reason); the source rows' status moves forward to 3.
 * Only Lume's own list rows are written.
 */
export const maxDuration = 120

const Body = z
  .object({ filter: FinalFilter, name: z.string().trim().min(1).max(200).optional(), preview: z.boolean().optional() })
  .refine((b) => b.preview || !!b.name, { message: 'name is required', path: ['name'] })

export async function POST(req: Request, ctx: ListCtx) {
  try {
    const auth = await requireOwner(req)
    if (!auth.ok) return auth.response
    const body = await parseJsonBody(req, Body, 32 * 1024)
    if (!body.ok) return body.response
    const r = await withList(ctx)
    if (!r.ok) return r.response
    const refused = leadsOnly(r.list)
    if (refused) return refused
    if (body.data.preview) return NextResponse.json(await previewFinal(r.list.id, body.data.filter))
    const out = await makeFinal(r.list.id, { name: body.data.name!, filter: body.data.filter, created_by: auth.via === 'internal' ? 'agent' : 'owner' })
    return NextResponse.json({ ...out, href: leadsHref(out.list.id) }, { status: 201 })
  } catch (err) {
    if (err instanceof StageRefused) return NextResponse.json({ error: err.code }, { status: err.status })
    return sourceErrorResponse(err) ?? dbErrorResponse(err, 'api/lead-lists/[id]/final')
  }
}
