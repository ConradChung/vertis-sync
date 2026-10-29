import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner, requireOwnerSession } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'
import { operatorCookieForbidden } from '@/lib/operators/guard'
import { getVertical } from '@/lib/operators/store'
import { logEvent } from '@/lib/db/service'
import { checkWebhookUrl } from '@/lib/webhooks/push'
import { deleteWebhook, getWebhook, setWebhook, toView } from '@/lib/webhooks/store'

/**
 * A vertical's outbound webhook (inbox manager 3f): the Grok routine Lume
 * pushes to (lib/webhooks/deliver.ts).
 *   GET    → `{ webhook: { url, secret_masked, updated_at, last_delivery_* } | null }`.
 *            Owner, bots and the agent may read; the secret is always masked.
 *   PUT    `{ url, secret? }` → `{ webhook, secret? }`. Without `secret` a
 *            new one is generated when none is stored and returned in this
 *            one response (no-store), never again; with none given and one
 *            stored, it is kept. 400 invalid_url / https_only / … .
 *   DELETE → `{ deleted: true }`.
 * PUT and DELETE: the owner's own session only (no agent bearer, no
 * `lume_op` cookie), like minting a key.
 */

const Body = z.strictObject({
  url: z.string().trim().min(1).max(2000),
  secret: z.string().trim().min(16).max(200).optional(),
})

async function guardWrite(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  return operatorCookieForbidden(req)
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_id' }, { status: 400 })
  try {
    const hook = await getWebhook(id)
    return NextResponse.json({ webhook: hook ? toView(hook) : null }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return dbErrorResponse(err, 'api/verticals/[id]/webhook')
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const refused = await guardWrite(req)
  if (refused) return refused
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_id' }, { status: 400 })
  const body = await parseJsonBody(req, Body, 4096)
  if (!body.ok) return body.response
  const bad = checkWebhookUrl(body.data.url)
  if (bad) return NextResponse.json({ error: bad }, { status: 400 })
  try {
    const v = await getVertical(id)
    if (!v || v.archived_at) return NextResponse.json({ error: 'vertical_not_found' }, { status: 404 })
    const existing = await getWebhook(id)
    const generated = !body.data.secret && !existing ? randomBytes(32).toString('base64url') : null
    const secret = body.data.secret ?? existing?.secret ?? generated!
    const hook = await setWebhook(id, body.data.url, secret)
    try {
      await logEvent({ type: 'lume.webhook_set', source: 'lume', source_id: id, title: `Webhook set for ${v.name}`, payload: { vertical_id: id, host: new URL(body.data.url).host, secret_changed: !!(body.data.secret || generated) } })
    } catch (err) {
      console.error('[api/verticals/webhook] logEvent failed:', err instanceof Error ? err.message : err)
    }
    return NextResponse.json({ webhook: toView(hook), ...(generated ? { secret: generated } : {}) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return dbErrorResponse(err, 'api/verticals/[id]/webhook')
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const refused = await guardWrite(req)
  if (refused) return refused
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_id' }, { status: 400 })
  try {
    return (await deleteWebhook(id)) ? NextResponse.json({ deleted: true }) : NextResponse.json({ error: 'not_found' }, { status: 404 })
  } catch (err) {
    return dbErrorResponse(err, 'api/verticals/[id]/webhook')
  }
}
