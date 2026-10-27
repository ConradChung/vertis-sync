import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { createVertical, listVerticals } from '@/lib/operators/store'
import { verticalConflict, VerticalFields } from '@/lib/operators/verticalSchema'
import { nonMasterOperatorForbidden } from '@/lib/operators/guard'
import { currentOperator } from '@/lib/operators/session'

/**
 * Verticals (Grok Bot lines of business).
 *   GET  → `{ verticals }`, live ones; `?archived=1` includes archived.
 *   POST `{ name, scopes?, campaign_ids?, is_default? }` → 201 `{ vertical }`;
 *        409 duplicate_name / default_taken. Created with no key.
 * Owner (session or the agent's internal bearer: create_vertical is a low tool).
 * A vertical Grok Bot may read but not create (403 master_only); the master
 * bot and the owner may.
 */

const Body = z
  .object({
    name: VerticalFields.name,
    scopes: VerticalFields.scopes.optional(),
    campaign_ids: VerticalFields.campaign_ids.optional(),
    is_default: VerticalFields.is_default.optional(),
  })
  .strict()

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const includeArchived = new URL(req.url).searchParams.get('archived') === '1'
  try {
    return NextResponse.json({ verticals: await listVerticals({ includeArchived }) })
  } catch (err) {
    return dbErrorResponse(err, 'api/verticals')
  }
}

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const refused = nonMasterOperatorForbidden(await currentOperator(req))
  if (refused) return refused
  const body = await parseJsonBody(req, Body, 8 * 1024)
  if (!body.ok) return body.response
  try {
    return NextResponse.json({ vertical: await createVertical(body.data) }, { status: 201 })
  } catch (err) {
    return verticalConflict(err) ?? dbErrorResponse(err, 'api/verticals')
  }
}
