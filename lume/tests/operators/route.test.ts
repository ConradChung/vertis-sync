import { describe, expect, it } from 'vitest'
import { GATE_KINDS, type PendingActionKind } from '@/lib/db/types'
import { itemsForOperator, routeItemForAction, scopeForGate, scopeForGateAction, scopeForPendingKind, verticalFor } from '@/lib/operators/route'
import type { Vertical } from '@/lib/operators/types'

const v = (id: string, name: string, extra: Partial<Vertical> = {}): Vertical => ({
  id, name, campaign_ids: [], scopes: [], is_default: false, created_at: '', archived_at: null, ...extra,
})

const JOBS = v('jobs', 'Job search / GTM roles', { scopes: ['orders', 'validation', 'campaign'], campaign_ids: ['gmail:recruiter'] })
const HNWI = v('hnwi', 'HNWI / wealth management', { scopes: ['validation', 'campaign'] })
const KASPEN = v('kaspen', 'Kaspen / Zenport', { scopes: ['orders', 'validation', 'campaign'], campaign_ids: ['camp-z'], is_default: true })
const ROOF = v('roof', 'Roofers', { scopes: ['campaign'], campaign_ids: ['camp-r'] })
const ALL = [ROOF, KASPEN, JOBS, HNWI]

describe('verticalFor', () => {
  it('1. the vertical whose campaign_ids holds the campaign wins over scope', () => {
    expect(verticalFor({ campaign_id: 'camp-r', scope: 'orders' }, ALL)).toBe(ROOF)
    expect(verticalFor({ campaign_id: ' camp-z ', scope: 'campaign' }, ALL)).toBe(KASPEN)
  })

  it('an archived vertical never claims, by campaign or scope or default', () => {
    const archivedRoof = { ...ROOF, archived_at: '2026-10-26T00:00:00Z' }
    expect(verticalFor({ campaign_id: 'camp-r' }, [archivedRoof, KASPEN])).toBe(KASPEN)
    expect(verticalFor({ scope: 'campaign' }, [archivedRoof])).toBeNull()
    expect(verticalFor({}, [{ ...KASPEN, archived_at: 'x' }])).toBeNull()
  })

  it('2. a scope match only when exactly one live vertical holds that scope', () => {
    const REPLIES = v('rep', 'Replies desk', { scopes: ['replies'] })
    expect(verticalFor({ campaign_id: 'camp-unknown', scope: 'replies' }, [...ALL, REPLIES])).toBe(REPLIES)
    expect(verticalFor({ scope: 'replies' }, [REPLIES, ROOF])).toBe(REPLIES)
    // input order does not matter
    expect(verticalFor({ scope: 'replies' }, [...ALL, REPLIES].reverse())).toBe(REPLIES)
    // an archived vertical does not make a scope ambiguous
    const archivedJobs = { ...JOBS, archived_at: '2026-10-26T00:00:00Z' }
    expect(verticalFor({ scope: 'orders' }, [archivedJobs, { ...KASPEN, is_default: false }, ROOF])).toEqual({ ...KASPEN, is_default: false })
  })

  it('2b. a scope held by several live verticals is ambiguous → the default, never the first by name', () => {
    // campaign: Roofers, Kaspen, Jobs, HNWI; orders: Jobs, Kaspen; validation: Jobs, HNWI, Kaspen
    expect(verticalFor({ campaign_id: 'camp-unknown', scope: 'campaign' }, ALL)).toBe(KASPEN)
    expect(verticalFor({ scope: 'orders' }, ALL)).toBe(KASPEN)
    expect(verticalFor({ scope: 'validation' }, ALL)).toBe(KASPEN)
    // ambiguous and no default → null (owner / master only)
    expect(verticalFor({ scope: 'campaign' }, [ROOF, JOBS, HNWI])).toBeNull()
  })

  it('3. no campaign or scope match → the default vertical', () => {
    expect(verticalFor({ scope: 'replies' }, ALL)).toBe(KASPEN)
    expect(verticalFor({ campaign_id: 'camp-unknown' }, ALL)).toBe(KASPEN)
    expect(verticalFor({}, ALL)).toBe(KASPEN)
  })

  it('4. nothing matches and no default → null', () => {
    expect(verticalFor({ scope: 'replies' }, [ROOF, JOBS])).toBeNull()
    expect(verticalFor({ campaign_id: null, scope: null }, [])).toBeNull()
  })
})

describe('itemsForOperator', () => {
  const items = [
    { id: 1, campaign_id: 'camp-r', scope: 'campaign' as const },
    { id: 2, campaign_id: null, scope: 'orders' as const },
    { id: 3, scope: 'replies' as const },
  ]
  it('the master bot sees every item, including unrouted ones', () => {
    expect(itemsForOperator({ is_master: true, vertical_id: null }, items, [ROOF]).map((i) => i.id)).toEqual([1, 2, 3])
  })
  it('a vertical bot sees only items routed to its vertical', () => {
    expect(itemsForOperator({ is_master: false, vertical_id: 'roof' }, items, ALL).map((i) => i.id)).toEqual([1])
    // orders is held by Jobs and Kaspen: ambiguous, so it goes to the default (Kaspen)
    expect(itemsForOperator({ is_master: false, vertical_id: 'jobs' }, items, ALL).map((i) => i.id)).toEqual([])
    expect(itemsForOperator({ is_master: false, vertical_id: 'kaspen' }, items, ALL).map((i) => i.id)).toEqual([2, 3])
    expect(itemsForOperator({ is_master: false, vertical_id: null }, items, ALL)).toEqual([])
  })
})

describe('scopes', () => {
  it('every pending kind maps: campaign kinds, replies, orders; decide_gate by gate', () => {
    const expected: Record<PendingActionKind, string | null> = {
      push_to_instantly: 'campaign', launch_campaign: 'campaign', assign_leads: 'campaign', activate_rule: 'campaign',
      delete_rule: 'campaign', pause_campaign: 'campaign', resume_campaign: 'campaign', create_campaign: 'campaign',
      update_sequence: 'campaign', send_reply: 'replies', crm_close_deal: 'replies', run_actor: 'orders', decide_gate: null,
      issue_operator_key: null, remove_leads: 'campaign', label_reply: 'replies', influencer_run: 'orders', influencer_reactions: 'orders',
      stage_attachment: 'validation',
    }
    for (const [kind, scope] of Object.entries(expected)) expect(scopeForPendingKind(kind)).toBe(scope)
    expect(scopeForPendingKind('nope')).toBeNull()
  })

  it('gate actions: ingest/finder/watchdog/push → validation; jobs/lfo → orders; launch → campaign', () => {
    for (const a of ['approve', 'approve_enrich', 'deny', 'finder_go', 'finder_skip', 'wd_resume', 'push_go', 'push_cancel']) {
      expect(scopeForGateAction(a)).toBe('validation')
    }
    for (const a of ['jobs_pull', 'jobs_order_now', 'jobs_abort', 'lfo_count', 'lfo_cancel']) expect(scopeForGateAction(a)).toBe('orders')
    expect(scopeForGateAction('camp_launch')).toBe('campaign')
    expect(scopeForGateAction('x')).toBeNull()
  })

  it('a pending action routes by its payload campaign and its kind / gate', () => {
    expect(routeItemForAction({ kind: 'pause_campaign', payload: { campaign_id: 'camp-r' } })).toEqual({ campaign_id: 'camp-r', scope: 'campaign' })
    expect(routeItemForAction({ kind: 'create_campaign', payload: { source_campaign_id: 'camp-z' } })).toEqual({ campaign_id: 'camp-z', scope: 'campaign' })
    expect(routeItemForAction({ kind: 'send_reply', payload: {} })).toEqual({ campaign_id: null, scope: 'replies' })
    expect(routeItemForAction({ kind: 'decide_gate', payload: { callback_data: 'lfo_count:abc:500' } })).toEqual({ campaign_id: null, scope: 'orders' })
    expect(routeItemForAction({ kind: 'decide_gate', payload: { callback_data: 'finder_go:abc' } })).toEqual({ campaign_id: null, scope: 'validation' })
    expect(routeItemForAction({ kind: 'run_actor', payload: null })).toEqual({ campaign_id: null, scope: 'orders' })
  })

  it('every lume_gates kind maps; push_review carries its campaign; lume_action routes as its action', () => {
    const gate = (kind: (typeof GATE_KINDS)[number], counts = {}, title: string | null = null) => scopeForGate({ kind, counts, title })
    for (const k of ['ingest_approval', 'finder_decision', 'campaign_choice', 'stall'] as const) expect(gate(k).scope).toBe('validation')
    for (const k of ['jobs_review', 'jobs_fill', 'jobs_write', 'jobs_stall', 'lfo_count'] as const) expect(gate(k).scope).toBe('orders')
    expect(gate('push_review', { campaign_id: 'camp-z' })).toEqual({ campaign_id: 'camp-z', scope: 'validation' })
    expect(gate('lume_action', { campaign_id: 'camp-r', summary: 's' }, 'resume_campaign')).toEqual({ campaign_id: 'camp-r', scope: 'campaign' })
    expect(gate('lume_action', {}, 'send_reply')).toEqual({ campaign_id: null, scope: 'replies' })
    for (const k of GATE_KINDS) expect(gate(k).scope).not.toBeUndefined()
  })

  it('end to end: a push_review on an unmapped campaign (validation is ambiguous) lands on the default', () => {
    expect(verticalFor(scopeForGate({ kind: 'push_review', counts: { campaign_id: 'camp-x' }, title: null }), ALL)).toBe(KASPEN)
    expect(verticalFor(scopeForGate({ kind: 'push_review', counts: { campaign_id: 'camp-x' }, title: null }), [ROOF, HNWI])).toBe(HNWI)
    expect(verticalFor(scopeForGate({ kind: 'push_review', counts: { campaign_id: 'camp-z' }, title: null }), ALL)).toBe(KASPEN)
  })
})

describe('owner-only items (issue_operator_key) and the master fallback (review fixes)', () => {
  it('issue_operator_key routes to no vertical, never the default', () => {
    const item = routeItemForAction({ kind: 'issue_operator_key', payload: { vertical_id: 'roof', summary: 's' } })
    expect(verticalFor(item, ALL)).toBeNull()
    const gate = scopeForGate({ kind: 'lume_action', title: 'issue_operator_key', counts: { vertical_id: 'roof' } })
    expect(verticalFor(gate, ALL)).toBeNull()
  })

  it('a vertical operator never sees it, even the default vertical; the master does', () => {
    const items = [routeItemForAction({ kind: 'issue_operator_key', payload: {} })]
    expect(itemsForOperator({ is_master: false, vertical_id: 'kaspen' }, items, ALL)).toEqual([])
    expect(itemsForOperator({ is_master: false, vertical_id: 'roof' }, items, ALL)).toEqual([])
    expect(itemsForOperator({ is_master: true, vertical_id: null }, items, ALL)).toHaveLength(1)
  })

  it('with a live master operator, unrouted items go to the master (null), not the default vertical', () => {
    const unrouted = { campaign_id: 'unknown', scope: 'validation' as const }
    expect(verticalFor(unrouted, ALL)?.id).toBe('kaspen')
    expect(verticalFor(unrouted, ALL, { masterLive: true })).toBeNull()
    // Campaign and sole-scope routing are unchanged.
    expect(verticalFor({ campaign_id: 'camp-r' }, ALL, { masterLive: true })?.id).toBe('roof')
    expect(itemsForOperator({ is_master: false, vertical_id: 'kaspen' }, [unrouted], ALL, { masterLive: true })).toEqual([])
    expect(itemsForOperator({ is_master: false, vertical_id: 'kaspen' }, [unrouted], ALL)).toEqual([unrouted])
  })
})
