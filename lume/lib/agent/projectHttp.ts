import 'server-only'
import { NextResponse } from 'next/server'
import { ProjectConflictError, ProjectGoneError } from '@/lib/agent/projects'
import { getVertical } from '@/lib/operators/store'
import { dbErrorResponse } from '@/lib/http/errors'

/** Shared responses for the project routes. */

export const notFound = (error = 'not_found') => NextResponse.json({ error }, { status: 404 })
export const badId = () => NextResponse.json({ error: 'invalid_id' }, { status: 400 })

/** A taken name or vertical → 409; a project deleted mid-request → 404; anything else the usual 500. */
export function projectErrorResponse(err: unknown, where: string): NextResponse {
  if (err instanceof ProjectConflictError) return NextResponse.json({ error: err.code }, { status: 409 })
  if (err instanceof ProjectGoneError) return NextResponse.json({ error: 'project_not_found' }, { status: 404 })
  return dbErrorResponse(err, where)
}

/** A vertical to link must exist and be live: a 400 response, or null when fine. */
export async function checkVertical(verticalId: string | null | undefined): Promise<NextResponse | null> {
  if (!verticalId) return null
  const v = await getVertical(verticalId)
  if (!v || (v as { archived_at?: string | null }).archived_at) return NextResponse.json({ error: 'vertical_not_found' }, { status: 400 })
  return null
}
