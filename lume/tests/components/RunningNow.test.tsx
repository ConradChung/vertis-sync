// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { ProgressItem } from '@/lib/progress/model'

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => nav.params, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/progress' }))
vi.mock('@/hooks/useValidationQueue', () => ({ useValidationQueue: () => ({ data: [], error: undefined, mutate: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() }) }))

import { ValidateScreen } from '@/components/validate/ValidateScreen'

const now = Date.now()
const iso = (msAgo: number) => new Date(now - msAgo).toISOString()
const RUN = '16f26ffc-1111-4111-8111-111111111111'
const item = (o: Partial<ProgressItem>): ProgressItem => ({
  key: 'k', kind: 'apify', label: 'Apify run', title: 't', status: 'running', stage: null, done: null, total: null, eta_seconds: null, eta_updated_at: null,
  cost_usd: null, cap_usd: null, started_at: iso(2 * 3600_000), updated_at: iso(60_000), finished: false, error: null, href: null, external: false, ...o,
})
const REASONS = [
  { status: 'valid', reason: 'Accepted', n: 4562 }, { status: 'invalid', reason: 'Catch-All', n: 181 }, { status: 'invalid', reason: 'No MX', n: 210 },
  { status: 'error', reason: 'MX Error', n: 300 }, { status: 'no_email', reason: null, n: 17 },
]
const jobProgress = (id: string) => ({
  id, filename: 'pm-leads.csv', status: 'processing', total_rows: 5272, processed_rows: 153, eta_seconds: 3600, eta_updated_at: null,
  eta_stage: null, eta_validate_seconds: null, eta_enrich_seconds: null,
  enrich: true, enrich_started: false, enriched_rows: 0, finder_status: null, rows_missing_email: null, emails_found: null,
  instantly_status: null, instantly_campaign_id: null, instantly_campaign_name: null, location_barrier: false, company_barrier: true, company_strict: false,
  counts: { pending: 5100, valid: 120, invalid: 30, error: 2, no_email: 1 },
})

let progress: { running: ProgressItem[]; recent: ProgressItem[]; unavailable?: string[] } = { running: [], recent: [] }
const fetchMock = vi.fn(async (url: string) => {
  if (url === '/api/progress') return Response.json(progress)
  if (/\/reasons/.test(url)) return Response.json({ reasons: REASONS })
  const m = /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(url)
  if (m) return Response.json(jobProgress(m[1]))
  return Response.json({})
})
const fresh = () => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><ValidateScreen /></SWRConfig>)

beforeEach(() => {
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  progress = { running: [], recent: [] }
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Progress: Running now', () => {
  it('one card per live process with kind, title, status · stage, bar, cost so far, started, and a link', async () => {
    progress = {
      running: [
        item({ key: 'apify:r1', kind: 'apify', label: 'Apify run', title: 'compass/crawler', status: 'running', done: 120, cost_usd: 0.42, href: 'https://console.apify.com/r1', external: true }),
        item({ key: 'influencer_lookup:b', kind: 'influencer_lookup', label: 'LinkedIn lookup', title: 'PM Influencers', status: 'looking up', done: 93, total: 133, cost_usd: 0.4, cap_usd: 1.19, href: '/import/leads?list=l1' }),
      ],
      recent: [],
    }
    fresh()
    const section = await screen.findByRole('region', { name: 'Running now' })
    const apify = within(section).getByRole('group', { name: 'Apify run: compass/crawler' })
    expect(apify.textContent).toContain('120 so far · $0.42 so far · started 2h ago')
    expect((within(apify).getByRole('link', { name: /Open/ }) as HTMLAnchorElement).href).toBe('https://console.apify.com/r1')
    const lookup = within(section).getByRole('group', { name: 'LinkedIn lookup: PM Influencers' })
    expect(lookup.textContent).toContain('93 / 133 · $0.40 of $1.19 so far')
    expect(within(lookup).getByRole('progressbar', { name: 'PM Influencers progress' })).toBeTruthy()
    expect(within(lookup).getByRole('link', { name: /Open/ }).getAttribute('href')).toBe('/import/leads?list=l1')
  })

  it('a validation job keeps its full panel: verify bar, verdicts, invalid rate by reason, ETA', async () => {
    progress = { running: [item({ key: `validation:${RUN}`, kind: 'validation', label: 'Validation', title: '5,272 leads · 05 Nov', status: 'processing', stage: 'validating', done: 153, total: 5272, job_id: RUN, href: `/progress?job=${RUN}` })], recent: [] }
    fresh()
    const section = await screen.findByRole('region', { name: 'Running now' })
    await within(section).findByRole('progressbar', { name: 'Verified' })
    expect(within(section).getByLabelText('Row verdicts')).toBeTruthy()
    const breakdown = await within(section).findByRole('group', { name: 'Validation results' })
    expect(within(breakdown).getByText('Invalid rate 7.9%')).toBeTruthy()
    expect(within(section).getByText('~1 h (initial estimate)')).toBeTruthy()
  })

  it('finished in the last 24 h: collapsed, with the error shown', async () => {
    progress = { running: [], recent: [item({ key: 'v:f', kind: 'validation', label: 'Validation', title: 'broken', status: 'failed', finished: true, error: 'MailTester: Disabled Key' })] }
    fresh()
    const section = await screen.findByRole('region', { name: 'Running now' })
    expect(within(section).getByText('Nothing is running right now.')).toBeTruthy()
    const finished = within(section).getByText('Finished in the last 24 h (1)').closest('details')!
    expect(finished.open).toBe(false)
    expect(within(finished).getByText('MailTester: Disabled Key')).toBeTruthy()
  })

  it('nothing running and no gate: one empty state', async () => {
    fresh()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/progress', expect.anything()))
    expect(await screen.findByText('Nothing running, nothing waiting on you.')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Running now' })).toBeNull()
  })

  it('while something runs, the gate empty state only speaks for gates', async () => {
    progress = { running: [item({ key: 'a', title: 'x' })], recent: [] }
    fresh()
    expect(await screen.findByText('Nothing waiting on you')).toBeTruthy()
  })
})
