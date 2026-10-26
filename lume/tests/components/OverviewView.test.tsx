// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import type { EventRow } from '@/lib/db/types'
import type { OverviewInstantly, OverviewPayload } from '@/lib/overview/types'

vi.mock('@/components/ui/number-ticker', () => ({
  NumberTicker: ({ value }: { value: number }) => <span>{value}</span>,
}))

let reduceMotion = true
// Lume always animates (lib/motion returns false). These tests pin the static
// render path so assertions don't race the count-up / list-in animations.
vi.mock('@/lib/motion', () => ({ useReducedMotion: () => reduceMotion }))
beforeAll(() => {
  // jsdom has no matchMedia; some libraries still read it.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (q: string) => ({
      matches: q.includes('reduce') ? reduceMotion : false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  })
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(cleanup)

import { OverviewView } from '@/components/overview/OverviewView'
import { ReplyFeed } from '@/components/overview/ReplyFeed'

const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString()
const ev = (id: number, o: Partial<EventRow> = {}): EventRow => ({
  id,
  type: 'reply',
  source: 'instantly',
  source_id: null,
  campaign_id: 'ic-1',
  lead_email: `lead${id}@northstar.com`,
  title: `Reply from lead${id}@northstar.com`,
  payload: { reply_text: `Happy to talk ${id}\nsecond line`, unibox_url: 'https://app.instantly.ai/app/unibox?thread=1' },
  webhook_id: null,
  created_at: iso(id),
  ...o,
})

const data: OverviewPayload = {
  now: new Date().toISOString(),
  pending_gates: 2,
  replies_today: 3,
  bounces_24h: 1,
  active_jobs: 0,
  lead_bank_queued: 1086,
  events_last_at: null,
  recent_events: [],
  days: ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'],
  replies_7d: [0, 1, 0, 2, 1, 1, 3],
  gates_opened_7d: [0, 0, 1, 0, 2, 0, 1],
  reply_feed: [ev(1), ev(2, { type: 'bounce', title: 'Bounce: lead2@northstar.com', payload: {} }), ev(3, { type: 'interested', source: 'telegram', title: 'Interested: lead3@northstar.com' })],
  agent_activity: [ev(9, { type: 'lume.decision', title: 'approve · ingest 42', source: 'lume' })],
  scheduled_jobs: [
    { name: 'pipeline-watchdog', cron: '*/5 * * * *', runner: 'pg_cron', active: true, target: null, last_status: 'succeeded', last_run_at: null, next_run: new Date(Date.now() + 120_000).toISOString() },
  ],
  next_runs: [],
}

const instantly: OverviewInstantly = {
  configured: true,
  campaign_source: 'lume_campaigns',
  sent_today: 684,
  sent_7d: [1, 2, 3, 4, 5, 6, 684],
  opportunities: 4,
  opportunities_value_usd: null,
  opportunities_7d: [0, 0, 0, 1, 0, 0, 0],
  accounts: [
    { email: 'kaspen@outlook.com', status: 'active', warmup_status: 'active', warmup_score: 92, daily_limit: 50 },
    { email: 'old@kaspen.io', status: 'active', warmup_status: 'banned', warmup_score: 38, daily_limit: 0 },
  ],
  campaigns: [
    { id: 'ic-1', name: 'Kaspen PM', sender: 'instantly', status: 'active', reply_rate: 0.5, sent: 400, replies: 2, series: [1, 2, 3, 4, 5, 6, 7], bounces_24h: 0, health: { level: 'amber', reason: 'Reply rate 0.5% is under 1%' } },
  ],
}

describe('OverviewView', () => {
  it('renders every card from the fixture', () => {
    render(<OverviewView data={data} instantly={instantly} />)
    expect(screen.getByRole('link', { name: 'Pending approvals: 2. Open Validate' })).toBeTruthy()
    expect(screen.getAllByTestId('kpi-value').map((n) => n.textContent)).toEqual(['684', '3', '2', '4'])
    // campaign strip: name, rate, violet needs-attention dot with words, plus an icon
    const strip = screen.getByLabelText('Campaigns')
    expect(within(strip).getByText('Kaspen PM')).toBeTruthy()
    expect(within(strip).getByText('0.5%')).toBeTruthy()
    // the feed resolves campaign ids to names from the strip
    expect(within(screen.getByLabelText('Live reply feed')).getAllByText('Kaspen PM').length).toBe(3)
    expect(screen.getByRole('img', { name: 'needs attention: Reply rate 0.5% is under 1%' })).toBeTruthy()
    // inbox health: both accounts, the banned one flagged as an error
    expect(screen.getByText('kaspen@outlook.com')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'error: warmup banned' })).toBeTruthy()
    // next runs + agent activity
    expect(screen.getByText('pipeline-watchdog')).toBeTruthy()
    expect(screen.getByText(/^in [12]m/)).toBeTruthy()
    expect(screen.getByText('approve · ingest 42')).toBeTruthy()
  })

  it('Instantly half still loading: DB cards render, Instantly cards shimmer', () => {
    const { container } = render(<OverviewView data={data} instantly={undefined} />)
    expect(screen.getByText('Live reply feed')).toBeTruthy()
    expect(screen.getByText('pipeline-watchdog')).toBeTruthy()
    expect(container.querySelectorAll('.anim-shimmer').length).toBeGreaterThan(4)
  })

  it('not connected: muted line on the Instantly cards', () => {
    render(<OverviewView data={data} instantly={{ configured: false, campaigns: [] }} />)
    expect(screen.getAllByText('Instantly not connected — set INSTANTLY_API_KEY')).toHaveLength(3)
    expect(screen.getByText('No campaigns yet.')).toBeTruthy()
  })

  it('error with no data: one line + retry', () => {
    const retry = vi.fn()
    render(<OverviewView data={undefined} error={new Error('x')} onRetry={retry} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain("Couldn't load the overview.")
    act(() => within(alert).getByRole('button', { name: 'Retry' }).click())
    expect(retry).toHaveBeenCalled()
  })
})

describe('ReplyFeed', () => {
  it('shows chip, email, title, first line, and Open only for Instantly events', () => {
    render(<ReplyFeed events={data.reply_feed} campaignNames={{ 'ic-1': 'Kaspen PM' }} />)
    expect(screen.getByText('lead1@northstar.com')).toBeTruthy()
    expect(screen.getByText('Happy to talk 1')).toBeTruthy()
    expect(screen.queryByText('second line')).toBeNull()
    expect(screen.getAllByText('Kaspen PM').length).toBe(3)
    const opens = screen.getAllByRole('link', { name: 'Open' })
    expect(opens).toHaveLength(2) // the telegram-sourced event has none
    expect(opens.map((a) => a.getAttribute('href'))).toContain('https://app.instantly.ai/app/unibox?thread=1')
    expect(opens.map((a) => a.getAttribute('href'))).toContain('https://app.instantly.ai/app/unibox?search=lead2%40northstar.com')
  })

  it('announces only when the newest event id changes; the list is not a live region', () => {
    const { rerender, container } = render(<ReplyFeed events={data.reply_feed} campaignNames={{}} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('')
    expect(container.querySelectorAll('[aria-live]').length).toBe(1)
    rerender(<ReplyFeed events={[...data.reply_feed]} campaignNames={{}} />)
    expect(status.textContent).toBe('')
    rerender(<ReplyFeed events={[ev(10, { created_at: iso(0) }), ...data.reply_feed]} campaignNames={{}} />)
    expect(status.textContent).toBe('New reply from lead10@northstar.com')
  })

  it('empty state: one line + one action', () => {
    render(<ReplyFeed events={[]} campaignNames={{}} />)
    expect(screen.getByText(/No replies yet/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Campaigns/ }).getAttribute('href')).toBe('/campaigns')
  })

  it('animated path renders without reduced motion', () => {
    reduceMotion = false
    try {
      render(<ReplyFeed events={data.reply_feed.slice(0, 1)} campaignNames={{}} />)
      expect(screen.getByText('lead1@northstar.com')).toBeTruthy()
    } finally {
      reduceMotion = true
    }
  })
})
