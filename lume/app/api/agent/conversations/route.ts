import { NextResponse } from 'next/server'
import { requireOwnerSession } from '@/lib/auth/guards'
import { listConversations } from '@/lib/agent/conversations'
import { dbErrorResponse } from '@/lib/http/errors'

/** GET → `{ conversations: [{ id, title, created_at, updated_at }] }`, most recent first (archived left out). */
export async function GET(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json({ conversations: await listConversations() })
  } catch (err) {
    return dbErrorResponse(err, 'api/agent/conversations')
  }
}
