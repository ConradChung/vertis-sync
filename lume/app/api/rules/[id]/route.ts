import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { deleteInactiveRule, findAwaitingRuleAction, getRule, logEvent, updateRule } from '@/lib/db/service'
import type { PendingActionKind } from '@/lib/db/types'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, uuidParam } from '@/lib/http/json'
import { nextRun } from '@/lib/rules/nextRun'
import { ACTIVATE_VIA_ACTION, updateRuleSchema } from '@/lib/rules/schema'

/**
 * One rotation rule.
 *  GET    → the row.
 *  PATCH  → edit fields, or pause (`active: false`). `active: true` → 400
 *           `activate_via_action`. Edits are refused (409 `activation_awaiting`)
 *           while an activate_rule confirmation is open: the owner is
 *           confirming a snapshot of this rule. Changing the cron of an active
 *           rule recomputes `next_run_at` in the owner's timezone.
 *  DELETE → only an inactive rule with no awaiting action (409 otherwise).
 */
type Ctx = { params: Promise<{ id: string }> }

const RULE_KINDS: PendingActionKind[] = ['activate_rule', 'assign_leads', 'delete_rule', 'remove_leads']

export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  try {
    const rule = await getRule(id)
    return rule ? NextResponse.json(rule) : NextResponse.json({ error: 'not_found' }, { status: 404 })
  } catch (err) {
    return dbErrorResponse(err, 'api/rules/[id]')
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  const body = await parseJsonBody(req, updateRuleSchema, 4096)
  if (!body.ok) return body.response
  const { active, ...fields } = body.data
  if (active === true) return NextResponse.json({ error: ACTIVATE_VIA_ACTION }, { status: 400 })

  try {
    const rule = await getRule(id)
    if (!rule) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (Object.keys(fields).length > 0 && (await findAwaitingRuleAction('activate_rule', id))) {
      return NextResponse.json({ error: 'activation_awaiting' }, { status: 409 })
    }
    const patch: Parameters<typeof updateRule>[1] = { ...fields }
    if (active === false) patch.active = false
    const stillActive = rule.active && active !== false
    if (stillActive && fields.cron && fields.cron !== rule.cron) patch.next_run_at = nextRun(fields.cron)
    const updated = await updateRule(id, patch)
    if (!updated) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    await logEvent({
      type: active === false && rule.active ? 'lume.rule_paused' : 'lume.rule_updated',
      source: 'lume',
      source_id: id,
      campaign_id: updated.campaign_id,
      title: active === false && rule.active ? `Rule "${updated.name}" paused` : `Rule "${updated.name}" edited`,
      payload: { fields: Object.keys(body.data) },
    }).catch(() => null)
    return NextResponse.json({ ok: true, rule: updated })
  } catch (err) {
    return dbErrorResponse(err, 'api/rules/[id]')
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  try {
    const rule = await getRule(id)
    if (!rule) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (rule.active) return NextResponse.json({ error: 'deactivate_first' }, { status: 409 })
    for (const kind of RULE_KINDS) {
      if (await findAwaitingRuleAction(kind, id)) return NextResponse.json({ error: 'action_awaiting' }, { status: 409 })
    }
    if (!(await deleteInactiveRule(id))) return NextResponse.json({ error: 'deactivate_first' }, { status: 409 })
    await logEvent({
      type: 'lume.rule_deleted',
      source: 'lume',
      source_id: id,
      campaign_id: rule.campaign_id,
      title: `Rule "${rule.name}" deleted`,
    }).catch(() => null)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return dbErrorResponse(err, 'api/rules/[id]')
  }
}
