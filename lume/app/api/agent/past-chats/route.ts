import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { searchPastChats } from '@/lib/agent/memory'
import { dbErrorResponse } from '@/lib/http/errors'

/** `GET /api/agent/past-chats?q=<text>` → `{ hits }` (messages and titles, newest first). */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim()
  if (q.length < 2 || q.length > 200) return NextResponse.json({ error: 'q is required (2-200 chars)' }, { status: 400 })
  try {
    return NextResponse.json({ hits: await searchPastChats(q) })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/past-chats')
  }
}
