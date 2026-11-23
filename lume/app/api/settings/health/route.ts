import { NextResponse } from 'next/server'
import { requireOwner, requireOwnerSession } from '@/lib/auth/guards'
import { healthState, runHealthChecks } from '@/lib/health/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * `GET /api/settings/health` — Config health: which secret names are set on
 * Vercel and on the edge functions (booleans only, never values) and the
 * last live-check run. Runs no live check.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json(await healthState(), { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'health_unavailable' }, { status: 500 })
  }
}

/**
 * `POST /api/settings/health` — run the live checks (Apify token, Telegram
 * send, Slack test-channel post, Railway worker) and store the result. The
 * owner's own session only: it sends real messages, so never the agent.
 */
export async function POST(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json(await runHealthChecks(), { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'checks_failed' }, { status: 500 })
  }
}
