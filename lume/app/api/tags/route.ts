import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { nonMasterOperatorForbidden } from '@/lib/operators/guard'
import { currentOperator } from '@/lib/operators/session'
import { TagBody } from '@/lib/tags/model'
import { listTags, setTag, UnknownTagError } from '@/lib/tags/store'

/**
 * Tags (an item's vertical).
 *   GET   → `{ tags: [{ id, name }] }`, the live verticals A→Z.
 *   PATCH `{ table, id, vertical_id | null }` → `{ item: { id, vertical_id, vertical_name } }`;
 *         404 not_found (no such row), 404 tag_not_found (no live vertical).
 * Owner (session or the agent's internal bearer: tag_item is a low tool). A
 * vertical Grok Bot may not retag (403 master_only). Rows that inherited the
 * old tag follow (database triggers); nothing else about the item changes.
 */

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json({ tags: await listTags() })
  } catch (err) {
    return dbErrorResponse(err, 'api/tags')
  }
}

export async function PATCH(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const refused = nonMasterOperatorForbidden(await currentOperator(req))
  if (refused) return refused
  const body = await parseJsonBody(req, TagBody, 2 * 1024)
  if (!body.ok) return body.response
  const { table, id, vertical_id } = body.data
  try {
    const item = await setTag({ table, id: id.toLowerCase() }, vertical_id ? vertical_id.toLowerCase() : null)
    if (!item) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json({ item })
  } catch (err) {
    if (err instanceof UnknownTagError) return NextResponse.json({ error: 'tag_not_found' }, { status: 404 })
    return dbErrorResponse(err, 'api/tags')
  }
}
