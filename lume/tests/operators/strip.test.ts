import { describe, expect, it } from 'vitest'
import { verticalCards } from '@/lib/operators/strip'
import type { GateRow, PendingActionRow } from '@/lib/db/types'

const V = (id: string, name: string, extra = {}) => ({ id, name, campaign_ids: [] as string[], scopes: [] as never[], is_default: false, created_at: '', archived_at: null, ...extra })
const now = new Date('2026-10-26T10:00:00Z')
const op = (id: string, vertical_id: string | null, last_seen_at: string | null, extra = {}) => ({
  id, vertical_id, is_master: false, label: id, created_at: '', revoked_at: null, last_seen_at, ...extra,
})

describe('verticalCards', () => {
  const verticals = [V('r', 'Roofers', { campaign_ids: ['camp-r'] }), V('k', 'Kaspen', { is_default: true }), V('x', 'Old', { archived_at: '2026-01-01' })]
  const gates = [
    { kind: 'lume_action', title: 'pause_campaign', counts: { campaign_id: 'camp-r' } },
    { kind: 'stall', title: 't', counts: {} },
  ] as unknown as GateRow[]
  const alerts = [{ id: '1', severity: 'urgent' as const, campaign_id: 'camp-r', scope: null, created_at: '' }]
  const decided = [
    { id: 'a1', kind: 'pause_campaign', payload: { summary: 'Pause R' }, status: 'executed', decided_via: 'operator', decided_by_operator: 'op-r', decided_at: '2026-10-26T09:00:00Z' },
    { id: 'a2', kind: 'resume_campaign', payload: {}, status: 'executed', decided_via: 'lume', decided_by_operator: null, decided_at: '2026-10-26T09:50:00Z' },
  ] as unknown as PendingActionRow[]

  it('one card per live vertical with check-in, counts and the bot’s last action', () => {
    const cards = verticalCards({
      verticals,
      operators: [op('op-r', 'r', '2026-10-26T09:45:00Z'), op('op-r-old', 'r', '2026-10-26T08:00:00Z', { revoked_at: 'x' }), op('op-m', null, '2026-10-26T09:59:00Z', { is_master: true, revoked_at: 'gone' })],
      gates, alerts, decided, now,
    })
    expect(cards.map((c) => c.id)).toEqual(['r', 'k'])
    expect(cards[0]).toEqual({
      id: 'r', name: 'Roofers', is_default: false, bots: 1, last_check_in: '2026-10-26T09:45:00Z', stale: false,
      needs_confirmation: 1, unacked_alerts: 1,
      last_bot_action: { id: 'a1', kind: 'pause_campaign', summary: 'Pause R', status: 'executed', decided_at: '2026-10-26T09:00:00Z' },
    })
    expect(cards[1]).toMatchObject({ bots: 0, last_check_in: null, stale: true, needs_confirmation: 1, unacked_alerts: 0, last_bot_action: null })
  })

  it('a live master bot takes unrouted items: the default vertical no longer counts them', () => {
    const cards = verticalCards({
      verticals, operators: [op('op-m', null, '2026-10-26T09:59:00Z', { is_master: true })], gates, alerts: [], decided: [], now,
    })
    expect(cards.find((c) => c.id === 'k')!.needs_confirmation).toBe(0)
    expect(cards.find((c) => c.id === 'r')!.needs_confirmation).toBe(1)
  })

  it('an operator-key request counts for no vertical, default included', () => {
    const keyGate = [{ kind: 'lume_action', title: 'issue_operator_key', counts: { vertical_id: 'r' } }] as unknown as GateRow[]
    const cards = verticalCards({ verticals, operators: [], gates: keyGate, alerts: [], decided: [], now })
    expect(cards.every((c) => c.needs_confirmation === 0)).toBe(true)
  })

  it('red after 30 minutes', () => {
    const [c] = verticalCards({ verticals: [verticals[0]], operators: [op('o', 'r', '2026-10-26T09:29:00Z')], gates: [], alerts: [], decided: [], now })
    expect(c.stale).toBe(true)
  })
})
