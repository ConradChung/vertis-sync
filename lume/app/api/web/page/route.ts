import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { PageError, fetchPage } from '@/lib/web/page'

/**
 * `GET /api/web/page?url=<url>` — readable text, title and same-site links of
 * one public web page (the agent's open_website fallback). Read-only.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const raw = new URL(req.url).searchParams.get('url') ?? ''
  if (!raw.trim() || raw.length > 2000) return NextResponse.json({ error: 'url is required (≤ 2000 chars)' }, { status: 400 })
  try {
    return NextResponse.json(await fetchPage(raw))
  } catch (err) {
    if (err instanceof PageError) {
      const status = err.code === 'bad_url' || err.code === 'blocked_address' ? 400 : 502
      return NextResponse.json({ error: err.code, message: err.message, ...(err.status ? { site_status: err.status } : {}) }, { status })
    }
    console.error('[api/web/page]', err)
    return NextResponse.json({ error: 'fetch_failed' }, { status: 502 })
  }
}
