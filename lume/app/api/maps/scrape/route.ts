import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { DuplicateActionError, InvalidActionPayloadError } from '@/lib/actions/create'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { MAPS_MAX_PER_SEARCH } from '@/lib/maps/scrape'
import { ACTOR_RUN_CAP_USD } from '@/lib/apify/pricing'
import { fileMapsScrape, MapsError, planMapsScrape } from '@/lib/maps/service'

/**
 * GTM-12 Google Maps scrape (owner, or the agent's bearer).
 *  GET  ?areas=a,b&regions=x&per_search=80 → the run_actor request it would file
 *       (search strings, limits, worst-case item count), fitted to the actor's
 *       live schema. Starts nothing.
 *  POST { areas?, regions?, per_search?, query?, max_charge_usd? } → 201 a
 *       run_actor pending action. The run starts only after Confirm in Lume
 *       or Approve in Telegram; Apify stops charging at the cap.
 */

const Body = z.object({
  areas: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
  regions: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  per_search: z.number().int().min(1).max(MAPS_MAX_PER_SEARCH).optional(),
  query: z.string().trim().min(3).max(80).optional(),
  max_charge_usd: z.number().positive().max(ACTOR_RUN_CAP_USD).optional(),
})

const list = (v: string | null) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined)

function mapsError(err: unknown, where: string) {
  if (err instanceof MapsError) return NextResponse.json({ error: err.code }, { status: err.status })
  if (err instanceof DuplicateActionError) return NextResponse.json({ error: 'duplicate', existing_id: err.existingId || null }, { status: 409 })
  if (err instanceof InvalidActionPayloadError) return NextResponse.json({ error: 'invalid_payload' }, { status: 400 })
  return dbErrorResponse(err, where)
}

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const q = new URL(req.url).searchParams
  const per = q.get('per_search')
  const parsed = Body.safeParse({ areas: list(q.get('areas')), regions: list(q.get('regions')), per_search: per ? Number(per) : undefined, query: q.get('query') ?? undefined })
  if (!parsed.success) return NextResponse.json({ error: 'invalid_query' }, { status: 400 })
  try {
    return NextResponse.json(await planMapsScrape(parsed.data))
  } catch (err) {
    return mapsError(err, 'api/maps/scrape')
  }
}

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, Body, 8 * 1024)
  if (!body.ok) return body.response
  try {
    const filed = await fileMapsScrape(body.data, auth.via === 'internal' ? 'agent' : 'user')
    return NextResponse.json(
      { ok: true, action: { id: filed.action.id, kind: filed.action.kind, summary: filed.summary }, areas: filed.plan.areas.length, dropped_fields: filed.plan.dropped_fields },
      { status: 201 },
    )
  } catch (err) {
    return mapsError(err, 'api/maps/scrape')
  }
}
