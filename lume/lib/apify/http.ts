import 'server-only'
import { NextResponse } from 'next/server'
import { ApifyError } from '@/lib/adapters/apify'

/** ApifyError → the JSON error the /api/apify routes answer with. */
export function apifyErrorResponse(err: unknown, where: string): NextResponse {
  if (err instanceof ApifyError) {
    if (err.code === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (err.code === 'not_configured') return NextResponse.json({ error: 'apify_not_configured' }, { status: 503 })
    if (err.code === 'timeout') return NextResponse.json({ error: 'apify_timeout' }, { status: 504 })
    console.error(`[${where}] ${err.message}`)
    return NextResponse.json({ error: 'apify_error', detail: err.message.slice(0, 200) }, { status: 502 })
  }
  throw err
}
