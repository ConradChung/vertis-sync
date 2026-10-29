import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { parseJsonBody } from '@/lib/http/json'
import { requestOrigin } from '@/lib/http/origin'
import { INSTALL_LINK_DAYS_DEFAULT, INSTALL_LINK_DAYS_MAX, signInstallLink } from '@/lib/slack/installLink'
import { slackOwnerGuard } from '@/lib/slack/ownerRoute'

/**
 * POST `{ days? }` → `{ url, expires_at }`: a signed, expiring install link
 * the owner sends a client (`/api/slack/install?t=…`). Owner's own session
 * only. A link can be used until it expires (by any number of workspaces);
 * every install still lands as an unbound workspace until the owner binds a
 * channel, so a forwarded link exposes no leads.
 */

const Body = z.strictObject({ days: z.number().int().min(1).max(INSTALL_LINK_DAYS_MAX).optional() })

export async function POST(req: Request) {
  const denied = await slackOwnerGuard(req)
  if (denied) return denied
  const body = await parseJsonBody(req, Body, 512)
  if (!body.ok) return body.response
  const expiresAt = Date.now() + (body.data.days ?? INSTALL_LINK_DAYS_DEFAULT) * 86_400_000
  const token = signInstallLink(process.env.LUME_SLACK_TOKEN_KEY!, { expiresAt, nonce: randomBytes(12).toString('base64url') })
  return NextResponse.json(
    { url: `${requestOrigin(req)}/api/slack/install?t=${encodeURIComponent(token)}`, expires_at: new Date(expiresAt).toISOString() },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
