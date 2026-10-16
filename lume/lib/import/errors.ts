import 'server-only'
import { NextResponse } from 'next/server'
import { dbErrorResponse } from '@/lib/http/errors'
import { StorageError } from '@/lib/import/storage'

/** createIngest / createApolloOrder failures → HTTP. Detail stays in the server log. */
export function intakeErrorResponse(err: unknown, where: string): NextResponse {
  if (err instanceof StorageError) {
    console.error(`[${where}] ${err.message}`)
    return NextResponse.json({ error: 'storage' }, { status: 502 })
  }
  return dbErrorResponse(err, where)
}

export function ingestBody(r: { ingest: { id: string }; rowCount: number; detectedColumn: string | null; telegram: string }) {
  return {
    ok: true as const,
    ingest_id: r.ingest.id,
    row_count: r.rowCount,
    email_column: r.detectedColumn,
    telegram: r.telegram,
    gate: `ingest_approval:${r.ingest.id}`,
  }
}
