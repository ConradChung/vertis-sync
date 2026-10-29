import { NextResponse } from 'next/server'
import { readBodyCapped } from '@/lib/http/readBody'
import { isSlackConfigured } from '@/lib/slack/config'
import { slackHeaders, verifySlackSignature } from '@/lib/slack/verify'

/**
 * Every request from Slack (events, interactions): refused with 503 while
 * the app is not configured, else the RAW body is read (capped) and its v0
 * signature checked (lib/slack/verify.ts) before anything is parsed.
 */

export const SLACK_BODY_MAX = 64 * 1024

export async function readSlackRequest(req: Request): Promise<{ ok: true; raw: string } | { ok: false; response: NextResponse }> {
  if (!isSlackConfigured()) return { ok: false, response: NextResponse.json({ error: 'slack_not_configured' }, { status: 503 }) }
  const body = await readBodyCapped(req, SLACK_BODY_MAX)
  if (!body.ok) return { ok: false, response: NextResponse.json({ error: 'too_large' }, { status: 413 }) }
  const v = verifySlackSignature(body.text, slackHeaders(req), process.env.SLACK_SIGNING_SECRET)
  if (!v.ok) return { ok: false, response: NextResponse.json({ error: 'bad_signature' }, { status: 401 }) }
  return { ok: true, raw: body.text }
}
