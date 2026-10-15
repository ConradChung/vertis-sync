import { NextResponse } from 'next/server'
import { isDbError } from '@/lib/db/service'

/**
 * One 500 shape for route handlers. Full detail goes to the server log; the
 * browser gets a generic code (a PostgREST message can carry table and column
 * names, which is nothing the UI needs).
 */
export function dbErrorResponse(err: unknown, where: string): NextResponse {
  if (isDbError(err)) {
    console.error(`[${where}] ${err.message}`, err.code ?? '', err.details ?? '', err.hint ?? '')
    return NextResponse.json({ error: 'database' }, { status: 500 })
  }
  console.error(`[${where}]`, err instanceof Error ? err.message : err)
  return NextResponse.json({ error: 'internal' }, { status: 500 })
}
