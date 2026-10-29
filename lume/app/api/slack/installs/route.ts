import { NextResponse } from 'next/server'
import { dbErrorResponse } from '@/lib/http/errors'
import { slackConfig } from '@/lib/slack/config'
import { requireOwnerSession } from '@/lib/auth/guards'
import { slackOwnerChecks } from '@/lib/slack/ownerRoute'
import { listBindings, listInstalls } from '@/lib/slack/store'

/** GET → `{ configured, missing, installs, bindings }` for Settings → Slack (never a token). */
export async function GET(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const denied = slackOwnerChecks(req, false)
  if (denied) return denied
  const cfg = slackConfig()
  try {
    const [installs, bindings] = await Promise.all([listInstalls(), listBindings()])
    return NextResponse.json({ configured: cfg.configured, missing: cfg.missing, installs, bindings }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return dbErrorResponse(err, 'api/slack/installs')
  }
}
