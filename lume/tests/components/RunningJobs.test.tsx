// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { JobSummary } from '@/lib/validate/jobs'

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => nav.params, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/validate' }))
vi.mock('@/hooks/useValidationQueue', () => ({ useValidationQueue: () => ({ data: [], error: undefined, mutate: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() }) }))

import { RunningJobs } from '@/components/validate/RunningJobs'
import { ValidateScreen } from '@/components/validate/ValidateScreen'

const now = Date.now()
const iso = (msAgo: number) => new Date(now - msAgo).toISOString()
const RUN = '16f26ffc-1111-4111-8111-111111111111'
const FAIL = '22222222-2222-4222-8222-222222222222'
const DONE = '33333333-3333-4333-8333-333333333333'
const job = (o: Partial<JobSummary>): JobSummary => ({
  id: RUN, filename: 'pm-leads.csv', status: 'processing', total_rows: 5272, processed_rows: 153, enrich: true,
  created_at: iso(2 * 3600_000), updated_at: iso(60_000), error_message: null, ...o,
})
let etaLive: Record<string, unknown> = {}
const progress = (id: string, status: string) => ({
  id, filename: 'pm-leads.csv', status, total_rows: 5272, processed_rows: 153, eta_seconds: 3600, eta_updated_at: null,
  eta_stage: null, eta_validate_seconds: null, eta_enrich_seconds: null, ...etaLive,
  enrich: true, enrich_started: false, enriched_rows: 0, finder_status: null, rows_missing_email: null, emails_found: null,
  instantly_status: null, instantly_campaign_id: null, instantly_campaign_name: null, location_barrier: false, company_barrier: true, company_strict: false,
  counts: { pending: 5100, valid: 120, invalid: 30, error: 2, no_email: 1 },
})

let jobs: JobSummary[] = []
const fetchMock = vi.fn(async (url: string) => {
  if (url === '/api/jobs') return Response.json({ jobs })
  const m = /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(url)
  if (m) return Response.json(progress(m[1], jobs.find((j) => j.id === m[1])?.status ?? 'processing'))
  return Response.json({})
})

const fresh = (ui: React.ReactElement) => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>)

beforeEach(() => {
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  jobs = []
  etaLive = {}
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('RunningJobs', () => {
  it('shows a running job with filename, status, start time and the JobProgress panel (verify bar, verdicts, enrich bar)', async () => {
    jobs = [job({})]
    fresh(<RunningJobs />)
    const section = await screen.findByRole('region', { name: 'Running jobs' })
    const card = await within(section).findByRole('group', { name: /^5,272 leads · / })
    const meta = within(card).getByText(/started 2h ago/).parentElement!
    expect(meta.textContent).toMatch(/^5,272 leads · \d{2} \w{3}·pm-leads\.csv·processing·started 2h ago$/)
    await within(card).findByRole('progressbar', { name: 'Verified' })
    expect(within(card).getByRole('progressbar', { name: 'Enrich queued' })).toBeTruthy()
    expect(within(card).getByLabelText('Row verdicts')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(`/api/jobs/${RUN}`, expect.anything())
    expect(within(card).getByText('~1 h (initial estimate)')).toBeTruthy()
  })

  it('a live ETA names its stage and the enrichment to come', async () => {
    jobs = [job({})]
    etaLive = { eta_stage: 'validating', eta_updated_at: new Date().toISOString(), eta_seconds: 12_600, eta_validate_seconds: 5400, eta_enrich_seconds: 7200 }
    fresh(<RunningJobs />)
    expect(await screen.findByText('Validating · ~1 h 30 min left, then enrichment ~2 h')).toBeTruthy()
  })

  it('lists jobs finished in the last 24 h collapsed; a failed one shows its error; progress loads only when opened', async () => {
    jobs = [
      job({ id: FAIL, filename: 'broken.csv', status: 'failed', error_message: 'MailTester: Disabled Key', updated_at: iso(3600_000) }),
      job({ id: DONE, filename: 'done.csv', status: 'completed', updated_at: iso(7200_000) }),
    ]
    fresh(<RunningJobs />)
    const section = await screen.findByRole('region', { name: 'Running jobs' })
    expect(within(section).getByText('No job is running right now.')).toBeTruthy()
    const finished = within(section).getByText('Finished in the last 24 h (2)').closest('details')!
    expect(finished.open).toBe(false)
    // The error is in the (collapsed) list, readable once opened, never silently dropped.
    expect(within(finished).getByText('MailTester: Disabled Key')).toBeTruthy()
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith('/api/jobs/'))).toBe(false)
    fireEvent.click(within(finished).getAllByText('Show progress')[0])
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/jobs/${FAIL}`, expect.anything()))
  })

  it('renders nothing when no job is running or recent', async () => {
    const { container } = fresh(<RunningJobs />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/jobs', expect.anything()))
    expect(container.textContent).toBe('')
  })
})

describe('Validate page', () => {
  it('shows the running job even when there are no gates; the gate empty state is unchanged', async () => {
    jobs = [job({})]
    fresh(<ValidateScreen />)
    expect(await screen.findByRole('region', { name: 'Running jobs' })).toBeTruthy()
    expect(screen.getByText('Nothing waiting on you')).toBeTruthy()
  })
})
