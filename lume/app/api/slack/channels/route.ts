import { NextResponse } from 'next/server'
import { z } from 'zod'
import { alert, alertLink } from '@/lib/alerts'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { getVertical } from '@/lib/operators/store'
import { CARD_FIELDS } from '@/lib/slack/card'
import { requireOwnerSession } from '@/lib/auth/guards'
import { slackOwnerChecks } from '@/lib/slack/ownerRoute'
import { getInstall, upsertBinding } from '@/lib/slack/store'

/**
 * PUT → bind (or re-bind) one channel of an installed workspace to a
 * vertical and, optionally, some of its campaigns (empty = all of them),
 * with the lead-card fields this client may see. Owner's own session only.
 * The campaigns must belong to the vertical; the workspace must be live.
 */

const Body = z.strictObject({
  team_id: z.string().regex(/^[TE][A-Z0-9]{2,30}$/),
  channel_id: z.string().regex(/^[CG][A-Z0-9]{2,30}$/),
  channel_name: z.string().trim().max(200).nullable().optional(),
  vertical_id: z.uuid(),
  campaign_ids: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  visible_fields: z.array(z.enum(CARD_FIELDS)).max(CARD_FIELDS.length),
  active: z.boolean().default(true),
})

export async function PUT(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const denied = slackOwnerChecks(req)
  if (denied) return denied
  const body = await parseJsonBody(req, Body, 16 * 1024)
  if (!body.ok) return body.response
  const b = body.data
  try {
    const [install, vertical] = await Promise.all([getInstall(b.team_id), getVertical(b.vertical_id.toLowerCase())])
    if (!install || install.revoked_at) return NextResponse.json({ error: 'not_installed' }, { status: 404 })
    if (!vertical || vertical.archived_at) return NextResponse.json({ error: 'vertical_not_found' }, { status: 404 })
    const campaigns = [...new Set(b.campaign_ids)]
    if (campaigns.some((c) => !vertical.campaign_ids.includes(c))) return NextResponse.json({ error: 'campaign_not_in_vertical' }, { status: 400 })
    const saved = await upsertBinding({
      team_id: b.team_id, channel_id: b.channel_id, channel_name: b.channel_name ?? null, vertical_id: vertical.id,
      campaign_ids: campaigns, visible_fields: b.visible_fields, active: b.active,
    })
    const title = `Slack channel ${b.channel_name ? `#${b.channel_name}` : b.channel_id} (${install.team_name ?? b.team_id}) bound to ${vertical.name}`
    try {
      await alert({ source: 'lume.settings', severity: 'info', title, body: `${title}\nCampaigns: ${campaigns.length ? campaigns.join(', ') : 'all of the vertical'}\nVisible: ${saved.visible_fields.join(', ') || 'none'}\nActive: ${saved.active}`, link: alertLink('/settings/slack'), owner_only: true })
    } catch (err) {
      console.error('[api/slack/channels] alert failed:', err instanceof Error ? err.message : err)
    }
    return NextResponse.json({ binding: saved })
  } catch (err) {
    return dbErrorResponse(err, 'api/slack/channels')
  }
}
