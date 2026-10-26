import { NextResponse } from 'next/server'
import { requireOwnerSession } from '@/lib/auth/guards'
import { listDiagrams, saveDiagram } from '@/lib/playground/diagrams'
import { newDiagramSchema } from '@/lib/playground/model'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'

/**
 * Saved Playground diagrams (owner session only).
 *  GET  → `{ diagrams }`, most recently updated first.
 *  POST → `{ spec, title?, source_conversation_id? }`; an identical live spec
 *         is reused (200) instead of saved twice (201).
 */
export async function GET(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json({ diagrams: await listDiagrams() })
  } catch (err) {
    return dbErrorResponse(err, 'api/playground/diagrams')
  }
}

export async function POST(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, newDiagramSchema, 96 * 1024)
  if (!body.ok) return body.response
  try {
    const { diagram, created } = await saveDiagram(body.data)
    return NextResponse.json({ diagram, created }, { status: created ? 201 : 200 })
  } catch (err) {
    return dbErrorResponse(err, 'api/playground/diagrams')
  }
}
