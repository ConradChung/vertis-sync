// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { PortalLead } from '@/lib/portal/types'

const nav = vi.hoisted(() => ({ params: new URLSearchParams('as=frank@example.com'), push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.params,
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => '/portal',
}))

import { PortalScreen } from '@/components/portal/PortalScreen'

const lead = (i: number): PortalLead => ({
  id: String(i), kind: 'email', name: `Lead ${i}`, first_name: `L${i}`, title: null, company: `Co ${i}`, phone: '+12145550100',
  phone_type: 'company', email: null, website: null, linkedin_url: null, city: 'Dallas', state: 'Texas', country: 'United States',
  region: null, timezone: null, campaign: 'Kaspen Main', reply_status: null, opened: false, replied: false,
})

// 5 leads, 2 per page → pages 1..3.
const TOTAL = 5
const PAGE = 2
const fetchMock = vi.fn((url: string) => {
  const u = new URL(url, 'http://x')
  const page = Number(u.searchParams.get('page'))
  const tab = u.searchParams.get('tab')
  const total = tab === 'email' ? TOTAL : 0
  const rows = tab === 'email' ? Array.from({ length: Math.max(0, Math.min(PAGE, total - (page - 1) * PAGE)) }, (_, k) => lead((page - 1) * PAGE + k + 1)) : []
  return Promise.resolve(new Response(JSON.stringify({ rows, total, page, pageSize: PAGE, regions: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
})

// IntersectionObserver stand-in: tests decide when the sentinel "intersects".
let observers: { cb: IntersectionObserverCallback; root: Element | null; els: Element[] }[] = []
class FakeIO {
  entry: { cb: IntersectionObserverCallback; root: Element | null; els: Element[] }
  constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
    this.entry = { cb, root: (opts?.root as Element | null) ?? null, els: [] }
    observers.push(this.entry)
  }
  observe(el: Element) {
    this.entry.els.push(el)
  }
  disconnect() {
    observers = observers.filter((o) => o !== this.entry)
  }
  unobserve() {}
  takeRecords() {
    return []
  }
}
function intersectSentinel() {
  const sentinel = screen.getByTestId('portal-sentinel')
  const live = observers.filter((o) => o.els.includes(sentinel))
  expect(live.length).toBeGreaterThan(0)
  act(() => {
    for (const o of live) o.cb([{ isIntersecting: true, target: sentinel } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
  })
}

beforeEach(() => {
  observers = []
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('IntersectionObserver', FakeIO)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const renderScreen = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PortalScreen />
    </SWRConfig>
  )

const emailPages = () => fetchMock.mock.calls.map(([u]) => new URL(u, 'http://x')).filter((u) => u.searchParams.get('tab') === 'email').map((u) => u.searchParams.get('page'))

describe('PortalScreen infinite list', () => {
  it('loads the next page when the sentinel scrolls into view, and stops at the end', async () => {
    renderScreen()
    await screen.findByText('Showing 2 of 5')
    expect(screen.getAllByText('Lead 1').length).toBeGreaterThan(0)
    expect(screen.queryByText('Lead 3')).toBeNull()

    intersectSentinel()
    await screen.findByText('Showing 4 of 5')
    expect(screen.getAllByText('Lead 4').length).toBeGreaterThan(0)

    intersectSentinel()
    await screen.findByText('Showing 5 of 5')
    expect(await screen.findByText('All 5 leads shown')).toBeTruthy()
    // At the end the sentinel is no longer observed, so nothing more is fetched.
    expect(observers.some((o) => o.els.includes(screen.getByTestId('portal-sentinel')))).toBe(false)
    expect(emailPages()).toEqual(['1', '2', '3'])
    // Every API call carries the owner-preview `as`.
    for (const [u] of fetchMock.mock.calls) expect(new URL(u, 'http://x').searchParams.get('as')).toBe('frank@example.com')
  })

  it('shows one company-line note instead of a line under every phone, and formats +1 numbers', async () => {
    renderScreen()
    await screen.findByText('Showing 2 of 5')
    expect(screen.getByText('Numbers are company lines — ask for the person by name')).toBeTruthy()
    expect(screen.queryByText(/Company line — ask for/)).toBeNull()
    expect(screen.getAllByText('+1 (214) 555-0100').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Dallas, TX').length).toBeGreaterThan(0)
  })

  it('filters reset the list (no page in the URL)', async () => {
    renderScreen()
    await screen.findByText('Showing 2 of 5')
    fireEvent.click(screen.getByRole('button', { name: 'Replied (positive)' }))
    expect(nav.push).toHaveBeenCalledWith('/portal?as=frank%40example.com&status=replied_positive', { scroll: false })
  })
})

describe('PortalScreen expand view', () => {
  it('Expand fills the viewport, Collapse and Esc exit', async () => {
    renderScreen()
    await screen.findByText('Showing 2 of 5')
    const panel = screen.getByTestId('portal-results')
    expect(panel.getAttribute('data-expanded')).toBe('false')
    expect(screen.getByRole('tablist')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(panel.getAttribute('data-expanded')).toBe('true')
    expect(panel.className).toContain('fixed')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByTestId('portal-scroller')).toBeTruthy()
    // The sentinel now observes against the expanded scroller.
    await waitFor(() => expect(observers.some((o) => o.root === screen.getByTestId('portal-scroller'))).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(panel.getAttribute('data-expanded')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(panel.getAttribute('data-expanded')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(panel.getAttribute('data-expanded')).toBe('false')
    expect(screen.getByRole('tablist')).toBeTruthy()
  })
})
