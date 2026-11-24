import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { ListBusy } from '@/lib/leads/lists/store'
import { leadsHref } from '@/lib/leads/lists/service'
import { MapsError } from '@/lib/maps/errors'
import { buildMapsSheet } from '@/lib/maps/sheet'

/**
 * GTM-12 Maps sheet (owner, or the agent's bearer).
 *  POST { run_id | dataset_id, name?, notes? } → 201 a new lead list with the
 *       finished Maps run's places, cleaned: closed places, places without a
 *       website of their own and duplicate domains dropped (each counted).
 *       Reads the Apify dataset only (free); sends nothing, runs nothing paid.
 */

export const maxDuration = 120

const ID = z.string().regex(/^[A-Za-z0-9]{8,40}$/)
const Body = z
  .object({ run_id: ID.optional(), dataset_id: ID.optional(), name: z.string().trim().min(1).max(200).optional(), notes: z.string().max(4000).optional() })
  .refine((v) => !!v.run_id !== !!v.dataset_id, 'run_id or dataset_id')

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, Body, 8 * 1024)
  if (!body.ok) return body.response
  const { run_id, dataset_id, name, notes } = body.data
  try {
    const out = await buildMapsSheet({ run_id, dataset_id }, { name, notes, by: auth.via === 'internal' ? 'agent' : 'owner' })
    return NextResponse.json({ ok: true, ...out, href: leadsHref(out.list_id) }, { status: 201 })
  } catch (err) {
    if (err instanceof MapsError) return NextResponse.json({ error: err.code }, { status: err.status })
    if (err instanceof ListBusy) return NextResponse.json({ error: 'list_busy' }, { status: 409 })
    return dbErrorResponse(err, 'api/maps/sheet')
  }
}
