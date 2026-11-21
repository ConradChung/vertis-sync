import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { requirePortalUser } from '@/lib/auth/guards'
import { createServiceClient } from '@/lib/supabase/service'
import { searchPortalLeads } from '@/lib/portal/leads'
import { PORTAL_AGENT_MAX_BODY_BYTES, PortalAgentBody, capMessages, runPortalAgent } from '@/lib/portal/agent'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/portal/agent { messages } → PortalAgentResponse.
 * Read-only lead-lookup assistant for the portal user (owner preview with
 * `?as=<portal email>`). Bodies over 20 KB are refused.
 */
export async function POST(req: Request) {
  const auth = await requirePortalUser(req)
  if (!auth.ok) return auth.response

  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > PORTAL_AGENT_MAX_BODY_BYTES) return NextResponse.json({ error: 'body_too_large' }, { status: 413 })
  const raw = await req.text()
  if (new TextEncoder().encode(raw).byteLength > PORTAL_AGENT_MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'body_too_large' }, { status: 413 })
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }
  const body = PortalAgentBody.safeParse(json)
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  const messages = capMessages(body.data.messages)
  if (!messages) return NextResponse.json({ error: 'last_message_must_be_user' }, { status: 400 })

  const db = createServiceClient()
  const user = auth.user
  try {
    // Same construction as the owner agent: the SDK reads ANTHROPIC_API_KEY.
    const result = await runPortalAgent({
      client: new Anthropic(),
      user,
      messages,
      search: (opts) => searchPortalLeads(db, user, opts),
    })
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } })
  } catch (err) {
    console.error('[portal/agent] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'agent_failed' }, { status: 502 })
  }
}
