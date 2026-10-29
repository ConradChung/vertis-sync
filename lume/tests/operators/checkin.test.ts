import { describe, expect, it } from 'vitest'
import type { EventRow, GateRow, PendingActionRow } from '@/lib/db/types'
import type { Vertical } from '@/lib/operators/types'
import {
  alertsForScope,
  checkinSummary,
  decisionEventsForScope,
  describeGate,
  formatUsd,
  groupByVertical,
  instantlyCampaignIds,
  leadsfridayCostText,
  leadsfridayUsd,
  needsConfirmation,
  newRepliesForScope,
  outcomesForScope,
  statsRanges,
} from '@/lib/operators/checkin'
import { routeItemForAction } from '@/lib/operators/route'

const V = (id: string, name: string, extra: Partial<Vertical> = {}): Vertical => ({
  id, name, campaign_ids: [], scopes: [], is_default: false, created_at: '', archived_at: null, ...extra,
})
const JOBS = V('v-jobs', 'Job search', { scopes: ['orders'], campaign_ids: ['camp-js'] })
const KASPEN = V('v-k', 'Kaspen', { scopes: ['campaign', 'validation'], is_default: true, campaign_ids: ['camp-k'] })
const ROOF = V('v-r', 'Roofers', { scopes: ['campaign'], campaign_ids: ['camp-r'] })
const verticals = [JOBS, KASPEN, ROOF]

const gate = (kind: GateRow['kind'], extra: Partial<GateRow> = {}): GateRow => ({
  kind, target_table: 'validation_jobs', target_id: `${kind}-id`, title: 't', subtitle: 's', actions: [], counts: {},
  telegram_message_id: null, created_at: '2026-10-26T10:00:00Z', ...extra,
})

describe('Leadsfriday cost', () => {
  it('count × $0.003, fractional cents kept', () => {
    expect(leadsfridayUsd(1234)).toBe(3.702)
    expect(formatUsd(leadsfridayUsd(1234))).toBe('$3.702')
    expect(formatUsd(leadsfridayUsd(500))).toBe('$1.50')
    expect(formatUsd(leadsfridayUsd(5000))).toBe('$15.00')
    expect(formatUsd(leadsfridayUsd(1001))).toBe('$3.003')
    expect(leadsfridayCostText(1234)).toBe('$3.702 (Leadsfriday: 1,234 × $0.003)')
  })
})

describe('describeGate', () => {
  it('lfo_count: money, routed by scope to the one orders vertical, count control', () => {
    const it = describeGate(gate('lfo_count', { target_table: 'apollo_orders' }), verticals)
    expect(it).toMatchObject({ priority: 'money', vertical_id: 'v-jobs', what: 'Leadsfriday count' })
    expect(it.cost).toContain('minimum 500 = $1.50')
    expect(it.control).toMatchObject({ type: 'lfo_count', target_id: 'lfo_count-id', cancel: { callback_data: 'lfo_cancel:lfo_count-id' } })
  })

  it('a decide_gate pending action with an lfo count shows the exact cost', () => {
    const g = gate('lume_action', {
      target_table: 'pending_actions', target_id: 'a1', title: 'decide_gate', subtitle: 'Gate decision',
      counts: { callback_data: 'lfo_count:o1:1234', summary: 'x' },
    })
    const it = describeGate(g, verticals)
    expect(it).toMatchObject({ priority: 'money', leads: 1234, cost: '$3.702 (Leadsfriday: 1,234 × $0.003)' })
    expect(it.control).toEqual({ type: 'approve_deny', action_id: 'a1' })
  })

  it('run_actor shows its Apify cap', () => {
    const g = gate('lume_action', {
      target_table: 'pending_actions', target_id: 'a2', title: 'run_actor',
      counts: { budget_usd: 5, estimate_usd: 1.25, cap_usd: 20 },
    })
    expect(describeGate(g, verticals)).toMatchObject({ priority: 'money', cost: 'Apify hard cap $5.00, estimate $1.25, ceiling $20.00' })
  })

  it('push_to_instantly routes by campaign and counts eligible leads', () => {
    const g = gate('lume_action', { target_table: 'pending_actions', title: 'push_to_instantly', counts: { campaign_id: 'camp-r', eligible: 42 } })
    expect(describeGate(g, verticals)).toMatchObject({ priority: 'validation', vertical_id: 'v-r', leads: 42 })
  })

  it('issue_operator_key links to the action page (the link is shown once there)', () => {
    const g = gate('lume_action', { target_table: 'pending_actions', target_id: 'a3', title: 'issue_operator_key' })
    expect(describeGate(g, verticals).control).toMatchObject({ type: 'link', href: '/actions/a3' })
  })

  it('campaign_choice: name input + stored candidates', () => {
    const g = gate('campaign_choice', { counts: { valid_count: 80, candidates: [{ id: 'c1', name: 'A' }, { bad: 1 }] } })
    const it = describeGate(g, verticals)
    expect(it).toMatchObject({ priority: 'validation', leads: 80, vertical_id: 'v-k' })
    expect(it.control).toMatchObject({ type: 'campaign_pick', job_id: 'campaign_choice-id', candidates: [{ id: 'c1', name: 'A' }] })
  })

  it('ingest_approval: only the offered buttons, spend flagged', () => {
    const it = describeGate(gate('ingest_approval', { actions: ['approve', 'approve_enrich', 'deny'], counts: { row_count: 300 } }), verticals)
    expect(it.control).toEqual({
      type: 'gate_buttons',
      buttons: [
        { label: 'Approve', callback_data: 'approve:ingest_approval-id', tone: 'approve', spends: false },
        { label: 'Approve + Enrich', callback_data: 'approve_enrich:ingest_approval-id', tone: 'approve', spends: true },
        { label: 'Deny', callback_data: 'deny:ingest_approval-id', tone: 'reject', spends: false },
      ],
    })
    const denyOnly = describeGate(gate('ingest_approval', { actions: ['deny'] }), verticals)
    expect(denyOnly.control.type === 'gate_buttons' && denyOnly.control.buttons.map((b) => b.label)).toEqual(['Deny'])
  })
})

describe('needsConfirmation', () => {
  const gates = [
    gate('lume_action', { target_table: 'pending_actions', target_id: 'p', title: 'pause_campaign', counts: { campaign_id: 'camp-k' }, created_at: '2026-10-26T01:00:00Z' }),
    gate('ingest_approval', { target_id: 'i', created_at: '2026-10-26T02:00:00Z' }),
    gate('lfo_count', { target_id: 'l', created_at: '2026-10-26T03:00:00Z' }),
    gate('jobs_fill', { target_id: 'f', created_at: '2026-10-26T00:30:00Z' }),
  ]
  it('all: money first, then validation, then the rest; oldest first inside', () => {
    expect(needsConfirmation(gates, verticals, { all: true }).map((i) => i.key)).toEqual([
      'jobs_fill:f', 'lfo_count:l', 'ingest_approval:i', 'lume_action:p',
    ])
  })
  it('one vertical: only its items', () => {
    expect(needsConfirmation(gates, verticals, { all: false, vertical: KASPEN }).map((i) => i.key)).toEqual([
      'ingest_approval:i', 'lume_action:p',
    ])
  })
  it('groupByVertical: by name, unrouted last', () => {
    const groups = groupByVertical([
      { vertical_id: null, vertical_name: null },
      { vertical_id: 'v-r', vertical_name: 'Roofers' },
      { vertical_id: 'v-k', vertical_name: 'Kaspen' },
    ])
    expect(groups.map((g) => g.vertical_name)).toEqual(['Kaspen', 'Roofers', 'No vertical (owner)'])
  })
})

describe('alertsForScope', () => {
  const alerts = [
    { id: '1', severity: 'info' as const, campaign_id: 'camp-r', scope: null, created_at: '2026-10-26T03:00:00Z' },
    { id: '2', severity: 'urgent' as const, campaign_id: 'camp-r', scope: null, created_at: '2026-10-26T01:00:00Z' },
    { id: '3', severity: 'warn' as const, campaign_id: 'camp-k', scope: null, created_at: '2026-10-26T04:00:00Z' },
    { id: '4', severity: 'urgent' as const, campaign_id: null, scope: 'orders' as const, created_at: '2026-10-26T02:00:00Z' },
  ]
  it('urgent on top, newest first', () => {
    expect(alertsForScope(alerts, verticals, { all: true }).map((a) => a.id)).toEqual(['4', '2', '3', '1'])
  })
  it('a vertical sees only its own', () => {
    expect(alertsForScope(alerts, verticals, { all: false, vertical: ROOF }).map((a) => a.id)).toEqual(['2', '1'])
  })
})

describe('outcomes, summary, ranges', () => {
  it('outcomesForScope routes decided actions like pending ones', () => {
    const row = (id: string, campaign: string) =>
      ({ id, kind: 'pause_campaign', payload: { campaign_id: campaign, summary: `Pause ${campaign}` }, status: 'executed', decided_via: 'operator',
        decided_by_operator: 'op1', decided_at: 'x', executed_at: 'y', error: null }) as unknown as PendingActionRow
    const out = outcomesForScope([row('a', 'camp-r'), row('b', 'camp-k')], verticals, { all: false, vertical: ROOF }, routeItemForAction)
    expect(out).toEqual([
      { id: 'a', kind: 'pause_campaign', summary: 'Pause camp-r', status: 'executed', decided_via: 'operator', decided_by_operator: 'op1',
        decided_at: 'x', executed_at: 'y', error: null, vertical_id: 'v-r' },
    ])
  })

  it('checkinSummary', () => {
    const s = checkinSummary({
      scope: { all: false, vertical: ROOF },
      items: [describeGate(gate('stall'), verticals)],
      alerts: [{ id: '1', severity: 'urgent', campaign_id: null, scope: null, created_at: '' }, { id: '2', severity: 'info', campaign_id: null, scope: null, created_at: '' }],
      lastCheckedAt: '2026-10-26T09:00:00Z',
      now: new Date('2026-10-26T10:00:00Z'),
    })
    expect(s).toEqual({
      vertical: { id: 'v-r', name: 'Roofers' }, needs_confirmation: 1, unacked_alerts: 2, urgent_alerts: 1, new_replies: 0,
      last_checked_at: '2026-10-26T09:00:00Z', generated_at: '2026-10-26T10:00:00.000Z',
    })
    expect(checkinSummary({ scope: { all: true }, items: [], alerts: [], lastCheckedAt: null, now: new Date(0) }).vertical).toBe('all')
    expect(checkinSummary({ scope: { all: true }, items: [], alerts: [], newReplies: 4, lastCheckedAt: null, now: new Date(0) }).new_replies).toBe(4)
  })

  it('a send_reply item gets the reply card control (edit + approve), not plain Approve / Deny', () => {
    const g = gate('lume_action', {
      target_table: 'pending_actions', target_id: 'act-r', title: 'send_reply', subtitle: 'Send reply to ada@acme.com',
      counts: { reply_to_uuid: 'e1', body: 'Tuesday?', lead_email: 'ada@acme.com', company: 'Acme', verdict: 'GOOD', proposed_times: ['Tue 10:00 PT'], campaign_id: 'camp-r' },
    })
    const item = describeGate(g, verticals)
    expect(item.what).toBe('Send a reply to a lead')
    expect(item.vertical_id).toBe('v-r')
    expect(item.control).toEqual({
      type: 'reply',
      action_id: 'act-r',
      card: expect.objectContaining({ lead_email: 'ada@acme.com', company: 'Acme', verdict: 'GOOD', draft: 'Tuesday?', proposed_times: ['Tue 10:00 PT'] }),
    })
  })

  it('newRepliesForScope: routed by campaign (replies scope), newest first, with the thread link and any awaiting draft', () => {
    const row = (id: string, campaign: string | null, at: string) => ({
      reply_to_uuid: id, campaign_id: campaign, lead_email: `${id}@x.com`, lead_name: id === 'r1' ? 'Ada' : null, company: 'Acme',
      excerpt: 'Yes please', received_at: at, thread_id: 't', eaccount: 'f@ours.com', subject: 's', interest: 1,
      source: 'poll' as const, created_at: at, handled_at: null, handled_how: null, handled_action_id: null,
    })
    const rows = [row('r1', 'camp-r', '2026-10-26T08:00:00Z'), row('r2', 'camp-r', '2026-10-26T09:00:00Z'), row('r3', 'camp-k', '2026-10-26T07:00:00Z')]
    const roof = newRepliesForScope(rows, verticals, { all: false, vertical: ROOF }, { r1: 'act-1' })
    expect(roof.map((r) => r.reply_to_uuid)).toEqual(['r2', 'r1'])
    expect(roof[1]).toMatchObject({
      lead: 'Ada <r1@x.com>', company: 'Acme', excerpt: 'Yes please', vertical_id: 'v-r', vertical_name: 'Roofers',
      thread_link: '/api/inbox/thread?reply_to_uuid=r1', draft_action_id: 'act-1',
    })
    expect(roof[0]).toMatchObject({ lead: 'r2@x.com', draft_action_id: null })
    expect(newRepliesForScope(rows, verticals, { all: true }, {}).map((r) => r.reply_to_uuid)).toEqual(['r2', 'r1', 'r3'])
  })

  it('statsRanges + instantlyCampaignIds', () => {
    expect(statsRanges(new Date('2026-10-26T10:00:00Z'))).toEqual({
      today: { startDate: '2026-10-26', endDate: '2026-10-26' },
      week: { startDate: '2026-10-20', endDate: '2026-10-26' },
    })
    expect(instantlyCampaignIds(['gmail:recruiter', '04ca2257-5ea6-434e-bf62-f55add156914'])).toEqual(['04ca2257-5ea6-434e-bf62-f55add156914'])
  })
})

describe('owner-only and master fallback on /operator (review fixes)', () => {
  const keyGate = gate('lume_action', { target_table: 'pending_actions', target_id: 'k1', title: 'issue_operator_key', counts: { vertical_id: 'v-r' } })
  it('a vertical operator never sees an operator-key request, the default vertical included', () => {
    for (const v of verticals) expect(needsConfirmation([keyGate], verticals, { all: false, vertical: v })).toEqual([])
    const all = needsConfirmation([keyGate], verticals, { all: true })
    expect(all.map((i) => [i.key, i.vertical_id])).toEqual([['lume_action:k1', null]])
  })
  it('with a live master, unrouted items leave the default vertical page', () => {
    // campaign scope is shared by Kaspen and Roofers, and no campaign: unrouted.
    const stall = gate('lume_action', { target_table: 'pending_actions', target_id: 's1', title: 'activate_rule', counts: {} })
    expect(needsConfirmation([stall], verticals, { all: false, vertical: KASPEN })).toHaveLength(1)
    expect(needsConfirmation([stall], verticals, { all: false, vertical: KASPEN }, { masterLive: true })).toEqual([])
    expect(needsConfirmation([stall], verticals, { all: true }, { masterLive: true })[0].vertical_id).toBeNull()
  })
})

describe('decisionEventsForScope (gate decisions and campaign picks in Recent outcomes)', () => {
  const ev = (id: number, type: string, extra: Partial<EventRow> = {}): EventRow => ({
    id, type, source: 'lume', source_id: 'job-1', campaign_id: null, lead_email: null, title: 't', payload: {}, webhook_id: null,
    created_at: `2026-10-26T0${id}:00:00Z`, ...extra,
  })
  const events = [
    ev(1, 'lume.decision', { title: 'deny from Grok Bot “Roof bot”', payload: { claimed: true, action: 'deny', decided_via: 'operator', operator_id: 'op-r' } }),
    ev(2, 'lume.decision', { title: 'lfo_count from Lume', payload: { claimed: false, action: 'lfo_count' } }),
    ev(3, 'lume.campaign_pick', { campaign_id: 'camp-r', title: 'Campaign picked in Lume: R', payload: { campaign_id: 'camp-r' } }),
    ev(4, 'agent.run'),
  ]

  it('maps decisions and picks, newest first; a lost claim is marked failed', () => {
    const out = decisionEventsForScope(events, verticals, { all: true })
    expect(out.map((o) => [o.kind, o.status, o.ok])).toEqual([
      ['campaign_pick', 'done', true],
      ['lfo_count', 'not applied: already handled elsewhere', false],
      ['deny', 'done', true],
    ])
    expect(out[2]).toMatchObject({ by_operator: 'op-r', summary: 'deny from Grok Bot “Roof bot”' })
  })

  it('routes by campaign, else by the action scope', () => {
    expect(decisionEventsForScope(events, verticals, { all: false, vertical: ROOF }).map((o) => o.kind)).toEqual(['campaign_pick'])
    expect(decisionEventsForScope(events, verticals, { all: false, vertical: JOBS }).map((o) => o.kind)).toEqual(['lfo_count'])
    expect(decisionEventsForScope(events, verticals, { all: false, vertical: KASPEN }).map((o) => o.kind)).toEqual(['deny'])
  })
})

describe('owner-only alerts', () => {
  it('never reach a vertical page, the default included; the all view keeps them', () => {
    const a = [{ id: 'o', severity: 'urgent' as const, campaign_id: null, scope: null, created_at: '', owner_only: true }]
    for (const v of verticals) expect(alertsForScope(a, verticals, { all: false, vertical: v })).toEqual([])
    expect(alertsForScope(a, verticals, { all: true })).toHaveLength(1)
  })
})
