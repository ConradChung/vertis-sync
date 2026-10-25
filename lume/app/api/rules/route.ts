import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getAwaitingRuleActions, getCampaigns, getRules, insertRule, logEvent } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { ACTIVATE_VIA_ACTION, createRuleSchema } from '@/lib/rules/schema'
import { withRuleMeta } from '@/lib/rules/view'

/**
 * Rotation rules.
 *  GET  → every rule with its campaign name and any awaiting action
 *         (activate_rule / assign_leads) tied to it.
 *  POST → create. Always inserted inactive; `active: true` is refused with
 *         400 `activate_via_action` — activation is a confirmed
 *         `pending_actions(kind='activate_rule')` (POST /api/actions).
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    const [rules, actions, campaigns] = await Promise.all([getRules(), getAwaitingRuleActions(), getCampaigns()])
    return NextResponse.json(withRuleMeta(rules, actions, campaigns))
  } catch (err) {
    return dbErrorResponse(err, 'api/rules')
  }
}

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, createRuleSchema, 4096)
  if (!body.ok) return body.response
  if (body.data.active === true) return NextResponse.json({ error: ACTIVATE_VIA_ACTION }, { status: 400 })
  const { name, campaign_id, filter, daily_cap, order_by, cron } = body.data
  try {
    const rule = await insertRule({ name, campaign_id, filter, daily_cap, order_by, cron })
    await logEvent({
      type: 'lume.rule_created',
      source: 'lume',
      source_id: rule.id,
      campaign_id,
      title: `Rule "${name}" created (inactive)`,
      payload: { by: auth.via === 'internal' ? 'agent' : 'user' },
    }).catch(() => null)
    return NextResponse.json({ ok: true, rule }, { status: 201 })
  } catch (err) {
    return dbErrorResponse(err, 'api/rules')
  }
}
