import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { parseJsonBody } from '@/lib/http/json'
import { configuredBaseUrl, requestOrigin } from '@/lib/http/origin'
import { INSTALL_LINK_DAYS_DEFAULT, INSTALL_LINK_DAYS_MAX, signInstallLink } from '@/lib/slack/installLink'
import { requireOwnerSession } from '@/lib/auth/guards'
import { slackOwnerChecks } from '@/lib/slack/ownerRoute'

/**
 * POST `{ days? }` → `{ url, expires_at }`: a signed, expiring install link
 * the owner sends a client (`/api/slack/install?t=…`). Owner's own session
 * only. A link can be used until it expires (by any number of workspaces);
 * every install still lands as an unbound workspace until the owner binds a
 * channel, so a forwarded link exposes no leads.
 *
 * The link's host is LUME_URL (the host the Slack app's redirect is
 * registered for), never the request's. In production without LUME_URL:
 * 503 `lume_url_unset`. Only in development does it fall back to the
 * request origin.
 */

const Body = z.strictObject({ days: z.number().int().min(1).max(INSTALL_LINK_DAYS_MAX).optional() })

export async function POST(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const denied = slackOwnerChecks(req)
  if (denied) return denied
  const body = await parseJsonBody(req, Body, 512)
  if (!body.ok) return body.response
  const base = configuredBaseUrl() || (process.env.NODE_ENV === 'production' ? '' : requestOrigin(req))
  if (!base) {
    return NextResponse.json({ error: 'lume_url_unset', message: 'Set LUME_URL on Vercel (the public Lume URL the Slack app redirects to) before generating install links.' }, { status: 503 })
  }
  const expiresAt = Date.now() + (body.data.days ?? INSTALL_LINK_DAYS_DEFAULT) * 86_400_000
  const token = signInstallLink(process.env.LUME_SLACK_TOKEN_KEY!, { expiresAt, nonce: randomBytes(12).toString('base64url') })
  return NextResponse.json(
    { url: `${base}/api/slack/install?t=${encodeURIComponent(token)}`, expires_at: new Date(expiresAt).toISOString() },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
