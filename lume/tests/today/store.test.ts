import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  getScoreboard: vi.fn(),
  listHiringRows: vi.fn(),
  loadWaitingReplies: vi.fn(),
  getPilotDeals: vi.fn(),
  listOpenTasksDue: vi.fn(),
}))
vi.mock('@/lib/scoreboard/store', () => ({ getScoreboard: m.getScoreboard }))
vi.mock('@/lib/hiring/store', () => ({ listHiringRows: m.listHiringRows }))
vi.mock('@/lib/replies/store', () => ({ loadWaitingReplies: m.loadWaitingReplies }))
vi.mock('@/lib/crm/service', () => ({ getPilotDeals: m.getPilotDeals }))
vi.mock('@/lib/tasks/store', () => ({ listOpenTasksDue: m.listOpenTasksDue }))

import { loadToday } from '@/lib/today/store'

const now = new Date('2026-11-26T20:00:00Z') // Thu noon Pacific
const board = { week: { start: '2026-11-23', end: '2026-11-30', label: 'Nov 23 – Nov 29' }, counts: { conversations: 2, pilots_started: 1, pilots_paid: 0 }, top_objection: null }
const reply = (id: string, received_at: string) => ({ reply_to_uuid: id, campaign_id: 'c', lead_email: `${id}@x.co`, lead_name: null, company: null, subject: null, untrusted_excerpt: null, received_at, deal_id: null, draft_action_id: null })
const pilot = (id: string, start: string | null, over: Record<string, unknown> = {}) => ({
  id, campaign_id: 'c', email: `${id}@x.co`, name: id, company: `${id} PM`, stage: 'Pilot', pilot_start_date: start, pilot_checkin_10_done_at: null, pilot_checkin_25_done_at: null, referral_asked_at: null, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  m.getScoreboard.mockResolvedValue(board)
  m.listHiringRows.mockResolvedValue({ rows: [{ id: 7, signal: 'hiring', role_title: 'Regional Property Manager', headline: null, company_name: 'Acme PM', company_domain: 'acme.com', posted_at: '2026-11-25T00:00:00Z', created_at: '2026-11-25T10:00:00Z' }], total: 31 })
  m.loadWaitingReplies.mockResolvedValue([reply('fresh', '2026-11-26T19:30:00Z'), reply('late', '2026-11-26T18:00:00Z'), reply('later', '2026-11-26T10:00:00Z')])
  m.getPilotDeals.mockResolvedValue([pilot('a', '2026-11-16'), pilot('b', '2026-11-20'), pilot('c', '2026-11-01', { pilot_checkin_10_done_at: '2026-11-11T00:00:00Z' })])
  m.listOpenTasksDue.mockResolvedValue([
    { id: 't1', title: 'Send Frank the recap', due_at: '2026-11-25T17:00:00Z', all_day: true, status: 'scheduled', action_id: null, linear_url: null },
    { id: 't2', title: 'Call Acme', due_at: '2026-11-26T22:00:00Z', all_day: false, status: 'scheduled', action_id: null, linear_url: null },
  ])
})

describe('loadToday (the Today queue)', () => {
  it('queues untouched signals, replies waiting over an hour, check-ins due and tasks due', async () => {
    const t = await loadToday(now)
    expect(t.today).toBe('2026-11-26')
    expect(t.scoreboard).toEqual(board)
    expect(t.queue.signals).toMatchObject({ total: 31, items: [{ key: 'hiring:7', company: 'Acme PM', untrusted_detail: 'Hiring: Regional Property Manager', href: '/signals/hiring' }] })
    // Only replies past 60 minutes, longest first; `open` still counts all three.
    expect(t.queue.replies.items.map((r) => r.reply_to_uuid)).toEqual(['later', 'late'])
    expect(t.queue.replies.open).toBe(3)
    // a: day 10 due today; c: day 10 done, day 25 due today; b: nothing yet.
    expect(t.queue.checkins.map((c) => [c.deal_id, c.day, c.days_late])).toEqual([['a', 10, 0], ['c', 25, 0]])
    expect(t.queue.tasks.map((x) => [x.id, x.overdue])).toEqual([['t1', true], ['t2', false]])
    expect(t.errors).toEqual([])
    // Tasks are read up to the end of today in the owner zone (midnight Pacific).
    expect(m.listOpenTasksDue).toHaveBeenCalledWith('2026-11-27T08:00:00.000Z')
    expect(m.listHiringRows).toHaveBeenCalledWith(expect.objectContaining({ status: 'new', skipped: false }))
  })

  it('one failing section is named and the rest still load', async () => {
    m.listHiringRows.mockRejectedValue(new Error('boom'))
    m.getScoreboard.mockRejectedValue(new Error('boom'))
    const t = await loadToday(now)
    expect(t.errors.sort()).toEqual(['scoreboard', 'signals'])
    expect(t.scoreboard).toBeNull()
    expect(t.queue.signals).toEqual({ items: [], total: 0 })
    expect(t.queue.checkins).toHaveLength(2)
    expect(t.queue.tasks).toHaveLength(2)
  })
})
