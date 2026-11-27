// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'

vi.mock('next/navigation', () => ({ usePathname: () => '/signals/reddit' }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), success: vi.fn() }) }))

import { SignalsSection } from '@/components/portal/SignalsSection'
import { SignalsInbox, inboxKey } from '@/components/signals/SignalsInbox'
import { SignalsNav, tabOf } from '@/components/signals/SignalsNav'
import type { PortalSignalsResponse } from '@/lib/portal/signals'
import type { SignalInbox, SignalRow } from '@/lib/signals/merge'

const wrap = (ui: ReactNode) => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const row = (o: Partial<SignalRow> & { key: string; name: string }): SignalRow => ({
  aliases: [],
  domain: null,
  sources: ['hiring'],
  count: 1,
  newest: { source: 'hiring', label: 'Hiring: Regional PM', at: '2026-11-25T20:00:00Z', url: 'https://jobs.example/1' },
  phone: null,
  contacts: [],
  events: [],
  latest: {},
  warmth: { tier: 3, at: null },
  state_key: o.key,
  status: 'new',
  touches: { email: null, linkedin: null, call: null },
  deal_id: null,
  ...o,
})
const inbox: SignalInbox = {
  total: 2,
  failed: [],
  counts: { new: 1, working: 1, replied: 0, dropped: 0 },
  rows: [
    row({
      key: 'd:acme.com',
      name: 'Acme PM',
      domain: 'acme.com',
      sources: ['hiring', 'comment', 'influencer'],
      count: 3,
      phone: '(310) 555-0101',
      contacts: [{ name: 'Ada Lovelace', title: 'COO', linkedin: null }],
    }),
    row({
      key: 'n:blue door',
      name: 'Blue Door',
      state_key: 'n:blue door',
      status: 'working',
      sources: ['reddit'],
      touches: { email: '2026-11-24T20:00:00Z', linkedin: null, call: null },
      deal_id: '5b7f2d1e-3c4a-4e8b-9f0a-1b2c3d4e5f60',
    }),
  ],
}

describe('inboxKey', () => {
  it('is the bare route for no filter and carries only what is set', () => {
    expect(inboxKey('all', 'all', '')).toBe('/api/signals/inbox')
    expect(inboxKey('hiring', 'all', '')).toBe('/api/signals/inbox?source=hiring')
    expect(inboxKey('reddit', 'working', 'acme pm')).toBe('/api/signals/inbox?source=reddit&status=working&q=acme+pm')
  })
})

describe('SignalsInbox', () => {
  it('shows one row per company with its sources, newest signal and date, status and three touches', () => {
    wrap(<SignalsInbox initial={inbox} />)
    const rows = within(screen.getByRole('list', { name: 'Signal accounts' })).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    const acme = rows[0]
    expect(within(acme).getByText('Acme PM')).toBeTruthy()
    expect(acme.querySelector('[data-sources]')?.textContent).toBe('Hiring · Post comment · Influencer reaction')
    expect(within(acme).getByRole('link', { name: 'Hiring: Regional PM' }).getAttribute('href')).toBe('https://jobs.example/1')
    expect(within(acme).getByText('Nov 25')).toBeTruthy()
    expect(within(acme).getByText('3 signals')).toBeTruthy()
    expect(within(acme).getByText('Ada Lovelace, COO')).toBeTruthy()
    expect(within(acme).getByRole('link', { name: '(310) 555-0101' }).getAttribute('href')).toMatch(/^tel:/)
    const touches = within(within(acme).getByRole('group', { name: 'Touches for Acme PM' })).getAllByRole('button')
    // A log, not actions: each touch reads as not done (—) until ticked.
    expect(touches.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Email—', 'false'],
      ['LinkedIn—', 'false'],
      ['Call—', 'false'],
    ])
    expect(within(acme).getByRole('button', { name: 'Add to pipeline' })).toBeTruthy()
  })

  it('a ticked touch shows its date; an account with a deal links to it in the Pipeline', () => {
    wrap(<SignalsInbox initial={inbox} />)
    const blue = within(screen.getByRole('list', { name: 'Signal accounts' })).getAllByRole('listitem')[1]
    const email = within(blue).getByRole('button', { name: 'Email done Nov 24' })
    expect(email.getAttribute('aria-pressed')).toBe('true')
    expect(email.textContent).toBe('EmailNov 24')
    expect(within(blue).queryByRole('button', { name: 'Add to pipeline' })).toBeNull()
    expect(within(blue).getByRole('link', { name: 'Open deal' }).getAttribute('href')).toBe('/crm?campaign=signals&deal=5b7f2d1e-3c4a-4e8b-9f0a-1b2c3d4e5f60')
  })

  it('ticking a touch PATCHes that account under its state key; Add to pipeline POSTs it and then links the deal', async () => {
    const calls: { url: string; method: string; body: unknown }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
        return new Response(JSON.stringify(url.startsWith('/api/signals/inbox') ? inbox : { ok: true, deal_id: 'deal-1', campaign_id: 'signals', created: true }), {
          status: url.endsWith('/deal') ? 201 : 200,
        })
      })
    )
    wrap(<SignalsInbox initial={inbox} />)
    const acme = () => within(screen.getByRole('list', { name: 'Signal accounts' })).getAllByRole('listitem')[0]
    fireEvent.click(within(acme()).getByRole('button', { name: 'Call' }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/signals/accounts')).toBe(true))
    expect(calls.find((c) => c.url === '/api/signals/accounts')).toEqual({ url: '/api/signals/accounts', method: 'PATCH', body: { key: 'd:acme.com', touch: { channel: 'call', done: true } } })
    await waitFor(() => expect((within(acme()).getByRole('button', { name: 'Add to pipeline' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(acme()).getByRole('button', { name: 'Add to pipeline' }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/signals/accounts/deal')).toBe(true))
    expect(calls.find((c) => c.url === '/api/signals/accounts/deal')).toEqual({ url: '/api/signals/accounts/deal', method: 'POST', body: { key: 'd:acme.com' } })
    await waitFor(() => expect(within(acme()).getByRole('link', { name: 'Open deal' }).getAttribute('href')).toBe('/crm?campaign=signals&deal=deal-1'))
    // Nothing else is called: no send, no pipeline route.
    expect(new Set(calls.map((c) => c.url.split('?')[0]))).toEqual(new Set(['/api/signals/accounts', '/api/signals/accounts/deal', '/api/signals/inbox']))
  })

  it('status filters carry the counts', () => {
    wrap(<SignalsInbox initial={inbox} />)
    const status = screen.getByRole('group', { name: 'Status' })
    expect(
      within(status)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['All2', 'New1', 'Working1', 'Replied0', 'Dropped0'])
  })

  it('a source tab fetches that source and shows its own columns', async () => {
    const comment = row({
      key: 'd:acme.com',
      name: 'Acme PM',
      sources: ['comment'],
      latest: {
        comment: {
          label: 'Commented',
          at: '2026-11-25T20:00:00Z',
          url: 'https://linkedin.com/c/1',
          person: 'Ada Lovelace',
          person_title: 'COO',
          linkedin: 'https://linkedin.com/in/ada',
          detail: { source: 'comment', reaction: false, comment: 'We miss after-hours calls', post_url: 'https://linkedin.com/posts/1', post_excerpt: 'Who answers your phones at night?' },
        },
      },
    })
    const thread = row({
      key: 'r:pm_dave',
      name: 'u/pm_dave',
      sources: ['reddit'],
      latest: {
        reddit: {
          label: 'r/Landlord: x',
          at: '2026-11-24T20:00:00Z',
          url: 'https://reddit.com/r/Landlord/1',
          person: null,
          person_title: null,
          linkedin: null,
          detail: { source: 'reddit', subreddit: 'Landlord', thread: 'Answering service?', excerpt: 'Asks who handles after-hours calls', author: 'pm_dave' },
        },
      },
    })
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        return new Response(JSON.stringify({ ...inbox, rows: url.includes('reddit') ? [thread] : [comment] }), { status: 200 })
      })
    )
    const { unmount } = wrap(<SignalsInbox fixedSource="comment" />)
    const c = await screen.findByText('“We miss after-hours calls”')
    expect(c.closest('a')?.getAttribute('href')).toBe('https://linkedin.com/c/1')
    expect(screen.getByRole('link', { name: 'Who answers your phones at night?' }).getAttribute('href')).toBe('https://linkedin.com/posts/1')
    expect(screen.getByRole('link', { name: 'Ada Lovelace' })).toBeTruthy()
    expect(document.querySelector('[data-heads]')?.textContent).toBe('PersonDoorsCommentPostDateTouchesStatusPipeline')
    unmount()
    wrap(<SignalsInbox fixedSource="reddit" />)
    expect(await screen.findByRole('link', { name: 'r/Landlord' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Answering service?' }).getAttribute('href')).toBe('https://reddit.com/r/Landlord/1')
    expect(screen.getByText('Asks who handles after-hours calls')).toBeTruthy()
    expect(document.querySelector('[data-heads]')?.textContent).toBe('AuthorSubredditThreadExcerptDateTouchesStatusPipeline')
    expect(urls).toEqual(['/api/signals/inbox?source=comment', '/api/signals/inbox?source=reddit'])
  })

  it('says so when a source could not load, and when there is nothing', () => {
    const { unmount } = wrap(<SignalsInbox initial={{ ...inbox, failed: ['reddit'] }} />)
    expect(screen.getByText(/Could not load reddit just now/)).toBeTruthy()
    unmount()
    wrap(<SignalsInbox initial={{ rows: [], total: 0, failed: [], counts: { new: 0, working: 0, replied: 0, dropped: 0 } }} />)
    expect(screen.getByText('No signal accounts yet.')).toBeTruthy()
  })
})

describe('Doors column', () => {
  const doorRows: SignalInbox = {
    ...inbox,
    rows: [
      row({ key: 'd:big.com', name: 'Big PM', domain: 'big.com', sources: ['influencer'], doors: { count: 1200, source: 'apollo', confidence: 'high' } }),
      row({ key: 'd:mid.com', name: 'Mid PM', domain: 'mid.com', sources: ['comment'] }),
      row({ key: 'd:jobs.com', name: 'Jobs PM', domain: 'jobs.com', sources: ['hiring'], hiring_id: 31 }),
    ],
  }
  const items = () => within(screen.getByRole('list', { name: 'Signal accounts' })).getAllByRole('listitem')

  it('shows the count with a thousands separator and its source on hover, Unknown when missing, the same for a hiring row', () => {
    wrap(<SignalsInbox initial={doorRows} />)
    const [big, mid, jobs] = items()
    expect(within(big).getByText('1,200').getAttribute('title')).toBe('Source: apollo · Confidence: high')
    expect(within(mid).getByText('Unknown')).toBeTruthy()
    expect(within(jobs).getByText('Unknown')).toBeTruthy()
    expect(document.querySelector('[data-heads]')?.textContent).toBe('AccountDoorsLatest signalTouchesStatusPipeline')
  })

  it('the Doors header sorts highest first, then lowest first, then off (the fetch carries it)', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return new Response(JSON.stringify(doorRows), { status: 200 }) }))
    wrap(<SignalsInbox initial={doorRows} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sort by doors' }))
    await waitFor(() => expect(urls).toContain('/api/signals/inbox?sort=doors_desc'))
    fireEvent.click(screen.getByRole('button', { name: 'Sort by doors, highest first' }))
    await waitFor(() => expect(urls).toContain('/api/signals/inbox?sort=doors_asc'))
  })

  it('500+ is off by default, sits beside the status filters and is not part of the status group', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return new Response(JSON.stringify(doorRows), { status: 200 }) }))
    wrap(<SignalsInbox initial={doorRows} />)
    const btn = screen.getByRole('button', { name: '500+' })
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(btn)
    await waitFor(() => expect(urls).toContain('/api/signals/inbox?min_doors=500'))
    expect(btn.getAttribute('aria-pressed')).toBe('true')
  })

  it('a hiring account with no count takes a typed one: saved on its hiring row, then the inbox refreshes', async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(JSON.stringify(url.includes('/units') ? { ok: true } : doorRows), { status: 200 })
    }))
    wrap(<SignalsInbox initial={doorRows} />)
    const [big, , jobs] = items()
    expect(within(big).queryByLabelText('Door count for Big PM')).toBeNull()
    fireEvent.change(within(jobs).getByLabelText('Door count for Jobs PM'), { target: { value: '750' } })
    fireEvent.click(within(jobs).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.find((c) => c.url === '/api/signals/hiring/31/units')?.body).toEqual({ units: 750 }))
  })

  it('the Reddit tab has no Doors column and no 500+ filter', async () => {
    const thread = row({ key: 'r:pm_dave', name: 'u/pm_dave', sources: ['reddit'] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...inbox, rows: [thread] }), { status: 200 })))
    wrap(<SignalsInbox fixedSource="reddit" />)
    await screen.findByRole('list', { name: 'Signal accounts' })
    expect(document.querySelector('[data-heads]')?.textContent).not.toContain('Doors')
    expect(screen.queryByRole('button', { name: '500+' })).toBeNull()
  })

  const held = row({ key: 'd:held.com', name: 'Held Co', sources: ['comment'], held: [{ id: 77, name: 'Hana Held' }] })
  it('a held person: the count cell says Unknown, and the typed count still releases them', async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(JSON.stringify(url.includes('/units') ? { outcome: 'continue', min_units: 500 } : { ...inbox, rows: [held] }), { status: 200 })
    }))
    wrap(<SignalsInbox fixedSource="comment" />)
    await screen.findByRole('list', { name: 'Signal accounts' })
    const li = items()[0]
    expect(within(li).getByText('Unknown')).toBeTruthy()
    expect(within(li).queryByText('Units unknown')).toBeNull()
    const input = within(li).getByLabelText('Unit count for Hana Held')
    fireEvent.change(input, { target: { value: '650' } })
    fireEvent.click(within(li).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/signals/people/77/units')).toBe(true))
    expect(calls.find((c) => c.url === '/api/signals/people/77/units')?.body).toEqual({ units: 650 })
  })
})

describe('SignalsNav', () => {
  it('has one tab per source and marks the current path', () => {
    render(<SignalsNav />)
    const nav = screen.getByRole('navigation', { name: 'Signals sources' })
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')])
    ).toEqual([
      ['All', '/signals', null],
      ['Post comments', '/signals/comments', null],
      ['Reddit', '/signals/reddit', 'page'],
      ['Hiring', '/signals/hiring', null],
      ['Influencers', '/signals/influencers', null],
    ])
  })
  it('tabOf: unknown paths under /signals are All', () => {
    expect([tabOf('/signals'), tabOf('/signals/hiring'), tabOf('/signals/influencers'), tabOf('/signals/comments'), tabOf(null)]).toEqual(['all', 'hiring', 'influencers', 'comments', 'all'])
  })
})

describe('SignalsSection (client portal)', () => {
  const body: PortalSignalsResponse = {
    enabled: true,
    more: 3,
    scoreboard: { week: { start: '2026-11-23', end: '2026-11-30', label: 'Nov 23 – Nov 29' }, counts: { conversations: 2, pilots_started: 1, pilots_paid: 0 }, top_objection: 'No budget until Q1' },
    accounts: [
      {
        key: 'd:acme.com',
        company: 'Acme PM',
        website: 'acme.com',
        phone: '+13105550101',
        sources: ['hiring'],
        untrusted_signal: 'Hiring: Regional PM',
        signal_at: '2026-11-25T20:00:00Z',
        contact: { name: 'Ada', title: 'COO', linkedin: null },
        status: 'new',
        called_at: null,
      },
      {
        key: 'n:blue door',
        company: 'Blue Door',
        website: null,
        phone: null,
        sources: ['influencer'],
        untrusted_signal: 'Reacted to Frank',
        signal_at: null,
        contact: null,
        status: 'working',
        called_at: null,
      },
    ],
  }
  const serve = (b: unknown, status = 200) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(b), { status }))
    )

  it('shows the scoreboard (read only) and the accounts with tap-to-call numbers; the owner preview rides along', async () => {
    serve(body)
    wrap(<SignalsSection as="frank@kaspen.co" />)
    const section = await screen.findByTestId('portal-signals')
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/portal/signals?as=frank%40kaspen.co')
    expect(section.querySelector('[data-stat="conversations"]')?.textContent).toBe('2')
    expect(within(section).getByText('No budget until Q1')).toBeTruthy()
    expect(within(section).queryByRole('textbox')).toBeNull()
    const list = within(section).getByRole('region', { name: 'Signal accounts to call today' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).getByRole('link', { name: /310/ }).getAttribute('href')).toMatch(/^tel:\+?1?3105550101/)
    expect(within(list).getByText('No phone yet')).toBeTruthy()
    expect(within(list).getByText('And 3 more.')).toBeTruthy()
    expect(within(list).queryByRole('button')).toBeNull()
  })

  it('renders nothing for a client without signals, and nothing on an error', async () => {
    serve({ enabled: false, accounts: [], more: 0, scoreboard: null })
    const { container, unmount } = wrap(<SignalsSection />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
    unmount()
    serve({ error: 'query_failed' }, 502)
    const again = wrap(<SignalsSection />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(again.container.innerHTML).toBe('')
  })
})
