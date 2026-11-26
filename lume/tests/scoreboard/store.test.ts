import { beforeEach, describe, expect, it, vi } from 'vitest'

/** A chainable stand-in for the Supabase query builder that records every call. */
type Call = { table: string; calls: [string, ...unknown[]][] }
const state = vi.hoisted(() => ({ made: [] as { table: string; calls: [string, ...unknown[]][] }[], results: {} as Record<string, unknown> }))

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from(table: string) {
      const q: Call = { table, calls: [] }
      state.made.push(q)
      const result = () => Promise.resolve({ data: state.results[table] ?? [], error: null })
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'gte', 'lt', 'order', 'limit', 'upsert']) {
        builder[m] = (...args: unknown[]) => {
          q.calls.push([m, ...args])
          return builder
        }
      }
      builder.maybeSingle = () => Promise.resolve({ data: state.results[`${table}:single`] ?? null, error: null })
      builder.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => result().then(ok, bad)
      return builder
    },
  }),
}))

import { COUNTED_STAGES, getScoreboard, setTopObjection } from '@/lib/scoreboard/store'

const now = new Date('2026-11-26T20:00:00Z')
const callsOn = (table: string) => state.made.filter((q) => q.table === table)

beforeEach(() => {
  state.made.length = 0
  state.results = {}
})

describe('getScoreboard (queries)', () => {
  it('asks only for moves into the counted stages, inside the owner-zone week', async () => {
    state.results.crm_activities = [
      { deal_id: 'a', payload: { to: 'Conversation' }, occurred_at: '2026-11-24T18:00:00Z' },
      { deal_id: 'b', payload: { to: 'Paid' }, occurred_at: '2026-11-25T18:00:00Z' },
    ]
    state.results.crm_deals = [{ id: 'p', pilot_start_date: '2026-11-25' }]
    state.results['lume_week_notes:single'] = { top_objection: 'No budget until Q1' }
    const board = await getScoreboard(now)
    expect(board).toEqual({
      week: { start: '2026-11-23', end: '2026-11-30', label: 'Nov 23 – Nov 29' },
      counts: { conversations: 1, pilots_started: 1, pilots_paid: 1 },
      top_objection: 'No budget until Q1',
    })
    const acts = callsOn('crm_activities')[0].calls
    expect(COUNTED_STAGES).toEqual(['Conversation', 'Paid'])
    // The stage filter is in the query, so replies and bounces (which also log stage changes) cannot crowd these rows out.
    expect(acts).toContainEqual(['in', 'payload->>to', ['Conversation', 'Paid']])
    expect(acts).toContainEqual(['eq', 'kind', 'stage_changed'])
    expect(acts).toContainEqual(['gte', 'occurred_at', '2026-11-23T08:00:00.000Z'])
    expect(acts).toContainEqual(['lt', 'occurred_at', '2026-11-30T08:00:00.000Z'])
    const deals = callsOn('crm_deals')[0].calls
    expect(deals).toContainEqual(['gte', 'pilot_start_date', '2026-11-23'])
    expect(deals).toContainEqual(['lt', 'pilot_start_date', '2026-11-30'])
    expect(deals.some(([m]) => m === 'in')).toBe(false)
  })

  it('a campaign filter narrows both reads (the client portal); no campaigns means zeros without a read', async () => {
    await getScoreboard(now, ['camp-1', 'camp-2'])
    expect(callsOn('crm_activities')[0].calls).toContainEqual(['in', 'crm_deals.campaign_id', ['camp-1', 'camp-2']])
    expect(callsOn('crm_activities')[0].calls[0]).toEqual(['select', 'deal_id, payload, occurred_at, crm_deals!inner(campaign_id)'])
    expect(callsOn('crm_deals')[0].calls).toContainEqual(['in', 'campaign_id', ['camp-1', 'camp-2']])
    state.made.length = 0
    const empty = await getScoreboard(now, [])
    expect(empty.counts).toEqual({ conversations: 0, pilots_started: 0, pilots_paid: 0 })
    expect(callsOn('crm_activities')).toHaveLength(0)
    expect(callsOn('crm_deals')).toHaveLength(0)
  })
})

describe('setTopObjection', () => {
  it('trims and caps the line; blank clears it', async () => {
    expect(await setTopObjection('2026-11-23', '  Too early in the year  ')).toBe('Too early in the year')
    expect(await setTopObjection('2026-11-23', '   ')).toBeNull()
    expect((await setTopObjection('2026-11-23', 'x'.repeat(400)))?.length).toBe(300)
    const [first, second] = callsOn('lume_week_notes').map((q) => q.calls[0])
    expect(first[1]).toMatchObject({ week_start: '2026-11-23', top_objection: 'Too early in the year' })
    expect(second[1]).toMatchObject({ top_objection: null })
  })
})
