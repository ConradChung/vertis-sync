import 'server-only'
import { NextResponse } from 'next/server'
import { getProject, ProjectConflictError, ProjectGoneError } from '@/lib/agent/projects'
import { canLinkVertical, canUseProject, type Project, type ProjectScope } from '@/lib/agent/projectModel'
import { currentOperator } from '@/lib/operators/session'
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

export const forbidden = () => NextResponse.json({ error: 'forbidden_project' }, { status: 403 })

/**
 * The caller's project scope: a vertical (non-master) Grok Bot on the owner
 * session is limited to its own vertical's project and unlinked ones; the
 * owner, the master bot and the internal bearer have full access (null).
 */
export async function projectScope(req: Request, auth: { via: 'session' | 'internal' }): Promise<ProjectScope> {
  if (auth.via !== 'session') return null
  const op = await currentOperator(req)
  return op && !op.is_master ? { verticalId: op.vertical_id } : null
}

/** A live project the caller may use: `{ project }`, or a 404 / 403 response. */
export async function requireProject(id: string, scope: ProjectScope): Promise<{ project: Project } | { response: NextResponse }> {
  const project = await getProject(id)
  if (!project) return { response: notFound() }
  if (!canUseProject(scope, project)) return { response: forbidden() }
  return { project }
}

/** A vertical link the caller may set: a 403 response, or null when fine. */
export const checkLink = (scope: ProjectScope, verticalId: string | null | undefined) => (canLinkVertical(scope, verticalId) ? null : forbidden())
