// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/hooks/useRealtimeInvalidate', () => ({ useRealtimeInvalidate: vi.fn() }))

import { PilotLine, PilotPanel } from '@/components/crm/PilotLine'
import { RepliesList } from '@/components/replies/RepliesList'
import { WaitChip } from '@/components/replies/WaitChip'
import { Scoreboard } from '@/components/today/Scoreboard'
import { TodayScreen } from '@/components/today/TodayScreen'
import type { RepliesPayload } from '@/lib/replies/queue'
import type { TodayPayload } from '@/lib/today/types'

const NOW = new Date('2026-11-26T20:00:00Z')
const wrap = (ui: ReactNode) => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>)
const board = { week: { start: '2026-11-23', end: '2026-11-30', label: 'Nov 23 – Nov 29' }, counts: { conversations: 4, pilots_started: 2, pilots_paid: 1 }, top_objection: 'Too early in the year' }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('WaitChip', () => {
  it('shows the wait and is flagged only past 60 minutes', () => {
    const { container, rerender } = render(<WaitChip since="2026-11-26T19:20:00Z" now={NOW} />)
    expect(container.querySelector('[data-wait]')?.textContent).toBe('40 min')
    expect(container.querySelector('[data-overdue]')).toBeNull()
    rerender(<WaitChip since="2026-11-26T19:00:00Z" now={NOW} />)
    expect(container.querySelector('[data-overdue]')).toBeNull()
    rerender(<WaitChip since="2026-11-26T18:45:00Z" now={NOW} />)
    expect(container.querySelector('[data-overdue]')?.textContent).toContain('1 h 15 min')
    // Flagged takes the one accent; not flagged stays grey.
    expect(container.querySelector('[data-overdue]')?.className).toContain('bg-primary')
    rerender(<WaitChip since="2026-11-26T19:20:00Z" now={NOW} />)
    expect(container.querySelector('[data-wait]')?.className).not.toContain('bg-primary')
  })
})

describe('Scoreboard', () => {
  it('shows the three counts, the week and the typed line', () => {
    render(<Scoreboard board={board} />)
    const stat = (k: string) => document.querySelector(`[data-stat="${k}"]`)?.textContent
    expect([stat('conversations'), stat('pilots_started'), stat('pilots_paid')]).toEqual(['4', '2', '1'])
    expect(screen.getByText('Nov 23 – Nov 29')).toBeTruthy()
    expect(screen.getByText('Too early in the year')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
  it('editable: saves the line on blur through PUT /api/scoreboard, and not when unchanged', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, top_objection: 'No budget until Q1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const onSaved = vi.fn()
    render(<Scoreboard board={board} editable onSaved={onSaved} />)
    const input = screen.getByLabelText('Top objection') as HTMLInputElement
    expect(input.value).toBe('Too early in the year')
    fireEvent.blur(input)
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'No budget until Q1' } })
    fireEvent.blur(input)
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('No budget until Q1'))
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/scoreboard')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ top_objection: 'No budget until Q1' })
  })
})

describe('RepliesList (/replies)', () => {
  const payload: RepliesPayload = {
    approvals: 1,
    replies: 1,
    items: [
      { type: 'reply', key: 'reply:r1', since: '2026-11-26T17:00:00Z', reply: { reply_to_uuid: 'r1', campaign_id: 'camp', lead_email: 'ada@acme.com', lead_name: 'Ada Lovelace', company: 'Acme PM', subject: null, untrusted_excerpt: 'Yes, send the video', received_at: '2026-11-26T17:00:00Z', deal_id: '5b7f2d1e-3c4a-4e8b-9f0a-1b2c3d4e5f60', draft_action_id: 'pa-7' } },
      { type: 'approval', key: 'approval:a1', since: '2026-11-26T19:45:00Z', approval: { id: 'a1', kind: 'company_check', label: 'ICP check', summary: 'Check 500 companies', cap_usd: 3.89, estimate_usd: null, requested_by: 'agent', created_at: '2026-11-26T19:45:00Z', notify_warning: null, open_only: false } },
    ],
  }
  it('lists replies and approvals together, each with its wait, flagged past the hour', () => {
    wrap(<RepliesList initial={payload} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Ada Lovelace')).toBeTruthy()
    expect(rows[0].querySelector('[data-overdue]')?.textContent).toContain('3 h 00 min')
    expect(within(rows[0]).getByRole('link', { name: 'Draft waiting for Confirm' }).getAttribute('href')).toBe('/actions/pa-7')
    expect(within(rows[0]).getByRole('link', { name: 'Open deal' }).getAttribute('href')).toBe('/crm?campaign=camp&deal=5b7f2d1e-3c4a-4e8b-9f0a-1b2c3d4e5f60')
    expect(within(rows[1]).getByText('Check 500 companies')).toBeTruthy()
    expect(rows[1].querySelector('[data-wait]')?.textContent).toBe('15 min')
    expect(rows[1].querySelector('[data-overdue]')).toBeNull()
    expect(within(rows[1]).getByRole('button', { name: 'Confirm' })).toBeTruthy()
    expect(within(rows[1]).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/actions/a1')
    expect(screen.getByText(/1 over an hour/)).toBeTruthy()
  })
  it('says so when nothing waits', () => {
    wrap(<RepliesList initial={{ items: [], approvals: 0, replies: 0 }} />)
    expect(screen.getByText('Nothing waiting for you.')).toBeTruthy()
  })
})

describe('TodayScreen (/today)', () => {
  const payload: TodayPayload = {
    today: '2026-11-26',
    scoreboard: board,
    errors: [],
    queue: {
      signals: { total: 12, items: [{ key: 'hiring:7', company: 'Acme PM', untrusted_detail: 'Hiring: Regional Property Manager', sources: ['Hiring'], at: '2026-11-25T00:00:00Z', href: '/signals/hiring' }] },
      replies: { open: 3, items: [{ reply_to_uuid: 'r1', campaign_id: 'c', lead_email: 'ada@acme.com', lead_name: 'Ada Lovelace', company: 'Acme PM', subject: null, untrusted_excerpt: 'Yes please', received_at: '2026-11-26T17:30:00Z', deal_id: null, draft_action_id: null }] },
      checkins: [{ deal_id: 'd1', campaign_id: 'camp', name: 'Frank', company: 'Kaspen', email: 'f@k.co', day: 10, due_date: '2026-11-24', days_late: 2 }],
      tasks: [{ id: 't1', title: 'Send Frank the recap', due_at: '2026-11-26T17:00:00Z', all_day: true, status: 'scheduled', action_id: null, linear_url: null, overdue: false }],
    },
  }
  it('shows the scoreboard and the four queues with their counts', () => {
    wrap(<TodayScreen initial={payload} />)
    expect(document.querySelector('[data-stat="conversations"]')?.textContent).toBe('4')
    const group = (name: string) => screen.getByRole('region', { name })
    expect(within(group('Replies waiting over an hour')).getByText('Ada Lovelace')).toBeTruthy()
    expect(group('Replies waiting over an hour').querySelector('[data-overdue]')?.textContent).toContain('2 h 30 min')
    expect(within(group('Pilot check-ins due')).getByText('Kaspen — day 10')).toBeTruthy()
    expect(within(group('Pilot check-ins due')).getByText(/2 d late/)).toBeTruthy()
    expect(group('Pilot check-ins due').querySelectorAll('[data-late]')).toHaveLength(1)
    expect(group('Tasks').querySelector('[data-late]')).toBeNull()
    expect(within(group('Signal accounts not yet touched')).getByText('Acme PM')).toBeTruthy()
    expect(group('Signal accounts not yet touched').querySelector('[data-count]')?.textContent).toBe('12')
    expect(within(group('Tasks')).getByText('Send Frank the recap')).toBeTruthy()
    // 12 signals + 1 reply + 1 check-in + 1 task.
    expect(screen.getByText('15 waiting')).toBeTruthy()
    expect(within(group('Tasks')).getByRole('link', { name: 'Calendar' }).getAttribute('href')).toBe('/calendar')
  })
  it('ticking a check-in patches the deal; nothing else is called', async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/today' ? payload : { ok: true, applied: true, deal: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    wrap(<TodayScreen initial={payload} />)
    fireEvent.click(within(screen.getByRole('region', { name: 'Pilot check-ins due' })).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => u === '/api/crm/deals/d1')).toBe(true))
    const call = fetch.mock.calls.find(([u]) => u === '/api/crm/deals/d1') as unknown as [string, RequestInit]
    expect(call[1].method).toBe('PATCH')
    expect(JSON.parse(String(call[1].body))).toEqual({ pilot_checkin_10_done: true })
  })
  it('an overdue task shows the date it was due in the owner zone, not UTC', () => {
    const late = { ...payload, queue: { ...payload.queue, tasks: [{ ...payload.queue.tasks[0], due_at: '2026-11-26T01:00:00Z', overdue: true }] } } // 5 pm Pacific on Nov 25
    wrap(<TodayScreen initial={late} />)
    expect(within(screen.getByRole('region', { name: 'Tasks' })).getByText('overdue since Nov 25')).toBeTruthy()
  })
  it('an empty queue reads clear, and a failed section is named', () => {
    wrap(<TodayScreen initial={{ today: '2026-11-26', scoreboard: null, errors: ['signals'], queue: { signals: { items: [], total: 0 }, replies: { items: [], open: 0 }, checkins: [], tasks: [] } }} />)
    expect(screen.getByText('clear')).toBeTruthy()
    expect(screen.getByText(/Could not load signals/)).toBeTruthy()
    expect(screen.getByText('No check-ins due.')).toBeTruthy()
  })
})

describe('Pilot on the deal card and sheet', () => {
  const base = { stage: 'Pilot', pilot_start_date: '2026-11-10', pilot_checkin_10_done_at: null, pilot_checkin_25_done_at: null, referral_asked_at: null }
  it('the card shows the start date, both check-ins and the referral flag', () => {
    render(<PilotLine deal={{ ...base, pilot_checkin_10_done_at: '2026-11-20T18:00:00Z' }} now={NOW} />)
    const line = screen.getByTestId('pilot-line')
    expect(line.textContent).toContain('Pilot · Nov 10 · day 16')
    expect(line.textContent).toContain('Day 10 done')
    expect(line.textContent).toContain('Day 25 · Dec 5')
    expect(line.textContent).toContain('Referral not asked')
  })
  it('a check-in past its day is marked due; a deal with no pilot shows nothing', () => {
    const { container, rerender } = render(<PilotLine deal={{ ...base, referral_asked_at: '2026-11-25T18:00:00Z' }} now={NOW} />)
    expect(container.querySelector('[data-tone="due"]')?.textContent).toBe('Day 10 due · 6 d late')
    expect(container.textContent).toContain('Referral asked')
    rerender(<PilotLine deal={{ ...base, stage: 'Replied', pilot_start_date: null }} now={NOW} />)
    expect(container.querySelector('[data-testid="pilot-line"]')).toBeNull()
  })
  it('a deal that left Pilot (Paid) shows its unticked check-ins as not done, never as due', () => {
    const { container } = render(<PilotLine deal={{ ...base, stage: 'Paid', pilot_start_date: '2026-10-01', pilot_checkin_10_done_at: '2026-10-11T18:00:00Z' }} now={NOW} />)
    expect(container.querySelector('[data-tone="due"]')).toBeNull()
    expect(container.textContent).toContain('Day 10 done')
    expect(container.textContent).toContain('Day 25 · not done')
    expect(container.innerHTML).not.toContain('bg-primary')
  })
  it('the sheet ticks a check-in and the referral flag through the deal patch', () => {
    const onSave = vi.fn()
    render(<PilotPanel deal={base} busy={false} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: /Day 10 due/ }))
    expect(onSave).toHaveBeenLastCalledWith({ pilot_checkin_10_done: true })
    fireEvent.click(screen.getByRole('button', { name: /Referral asked\?/ }))
    expect(onSave).toHaveBeenLastCalledWith({ referral_asked: true })
  })
})
