// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { GateRow, RunRow } from '@/lib/db/types'
import type { ProgressItem } from '@/lib/progress/model'

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => nav.params, useRouter: () => ({ push: vi.fn(), replace: nav.replace }), usePathname: () => '/progress' }))
const queue = vi.hoisted(() => ({ gates: [] as GateRow[] }))
vi.mock('@/hooks/useValidationQueue', () => ({ useValidationQueue: () => ({ data: queue.gates, error: undefined, mutate: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() }) }))

import { ProgressScreen } from '@/components/progress/ProgressScreen'

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.scrollTo = () => {}
})

const now = Date.now()
const iso = (msAgo: number) => new Date(now - msAgo).toISOString()
const DONE = 'aaaaaaaa-1111-4111-8111-111111111111'
const RUNNING = 'bbbbbbbb-1111-4111-8111-111111111111'
const PICK = 'cccccccc-1111-4111-8111-111111111111'
const OLD = 'eeeeeeee-1111-4111-8111-111111111111'
const BATCH = 'dddddddd-1111-4111-8111-111111111111'

const run = (id: string, o: Partial<RunRow>): RunRow => ({
  id, filename: `${id.slice(0, 4)}.csv`, display_name: null, status: 'completed', total_rows: 1000, processed_rows: 1000, valid_count: 800, enrich: false,
  finder_status: null, instantly_status: null, source: 'telegram', created_at: iso(3 * 86_400_000), updated_at: iso(3 * 86_400_000), vertical_id: null, ...o,
})
const RUNS: RunRow[] = [
  run(DONE, { display_name: 'Finished list', updated_at: iso(60_000) }),
  run(RUNNING, { display_name: 'PM leads', status: 'processing', processed_rows: 153, total_rows: 5272, updated_at: iso(3600_000) }),
  run(PICK, { display_name: 'UK agents', instantly_status: 'awaiting_campaign', updated_at: iso(7200_000) }),
]
const job = (id: string) => {
  const r = [...RUNS, run(OLD, { display_name: 'Old list' })].find((x) => x.id === id)!
  return {
    id, filename: r.filename, display_name: r.display_name, created_at: r.created_at, status: r.status, total_rows: r.total_rows, processed_rows: r.processed_rows,
    eta_seconds: null, eta_updated_at: null, eta_stage: null, eta_validate_seconds: null, eta_enrich_seconds: null,
    enrich: false, enrich_started: false, enriched_rows: 0, finder_status: null, rows_missing_email: null, emails_found: null,
    instantly_status: r.instantly_status, instantly_campaign_id: null, instantly_campaign_name: null, location_barrier: false, company_barrier: true, company_strict: false,
    instantly_pushed: 0, instantly_pushed_nolocation: 0, source: 'telegram', vertical_id: null,
    counts: r.status === 'processing' ? { pending: 5119, valid: 120, invalid: 30, error: 2, no_email: 1 } : { pending: 0, valid: 800, invalid: 150, error: 30, no_email: 20 },
  }
}
const gate = (kind: GateRow['kind'], target: string, o: Partial<GateRow> = {}): GateRow => ({
  kind, target_table: 'validation_jobs', target_id: target, title: `${kind} title`, subtitle: null, actions: [], counts: {}, telegram_message_id: null, created_at: iso(60_000), ...o,
})
const item = (o: Partial<ProgressItem>): ProgressItem => ({
  key: 'k', kind: 'apify', label: 'Apify run', title: 't', status: 'running', stage: null, done: null, total: null, eta_seconds: null, eta_updated_at: null,
  cost_usd: null, cap_usd: null, started_at: iso(2 * 3600_000), updated_at: iso(60_000), finished: false, error: null, href: null, external: false, ...o,
})

let runs: RunRow[] = RUNS
let progress: { running: ProgressItem[]; recent: ProgressItem[] } = { running: [], recent: [] }
const fetchMock = vi.fn(async (url: string) => {
  if (url === '/api/progress') return Response.json(progress)
  if (url.startsWith('/api/validation-jobs/runs')) return Response.json({ runs })
  if (/\/reasons/.test(url)) return Response.json({ reasons: [] })
  const m = /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(url)
  if (m) return Response.json(job(m[1]))
  return new Response('{}', { status: 404 })
})
const fresh = () => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><ProgressScreen /></SWRConfig>)
const detail = () => screen.findByRole('region', { name: 'Step detail' })

beforeEach(() => {
  fetchMock.mockClear()
  nav.replace.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  nav.params = new URLSearchParams()
  queue.gates = []
  runs = RUNS
  progress = { running: [], recent: [] }
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Progress: runs', () => {
  it('opens on the most recent run that is running or waiting on you, at its active step; no "All" view', async () => {
    fresh()
    const nav_ = await screen.findByRole('navigation', { name: 'Runs' })
    await waitFor(() => expect(within(nav_).getByRole('button', { name: /PM leads/, pressed: true })).toBeTruthy())
    expect(within(nav_).queryByRole('button', { name: /^All/ })).toBeNull()
    const step = await screen.findByRole('button', { name: 'Validate: Running', current: 'step' })
    expect(step).toBeTruthy()
    const panel = await detail()
    expect(within(panel).getByRole('heading', { name: 'Validate' })).toBeTruthy()
    expect(await within(panel).findByRole('progressbar', { name: 'Verified' })).toBeTruthy()
  })

  it('a run waiting on you wins over a newer finished one, and its step is the one waiting', async () => {
    queue.gates = [gate('campaign_choice', PICK)]
    runs = RUNS.map((r) => (r.id === RUNNING ? { ...r, status: 'completed' } : r))
    fresh()
    await waitFor(() => expect(screen.getByRole('button', { name: /UK agents — Needs you/, pressed: true })).toBeTruthy())
    expect(await screen.findByRole('button', { name: 'Campaign: Your move', current: 'step' })).toBeTruthy()
  })

  it('?run= selects that run; picking another tile writes ?run= to the URL', async () => {
    nav.params = new URLSearchParams(`run=${DONE}`)
    fresh()
    await waitFor(() => expect(screen.getByRole('button', { name: /Finished list/, pressed: true })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /PM leads/ }))
    expect(nav.replace).toHaveBeenCalledWith(`/progress?run=${RUNNING}`, { scroll: false })
    await waitFor(() => expect(screen.getByRole('button', { name: /PM leads/, pressed: true })).toBeTruthy())
  })

  it('?run= for a run older than the switcher adds it as a tile', async () => {
    nav.params = new URLSearchParams(`run=${OLD}`)
    fresh()
    await waitFor(() => expect(screen.getByRole('button', { name: /Old list/, pressed: true })).toBeTruthy())
  })

  it('?gate= opens the gate’s run at its step; its buttons render only in the step panel', async () => {
    queue.gates = [gate('campaign_choice', PICK), gate('jobs_review', BATCH, { target_table: 'job_batches', title: 'GTM batch' })]
    nav.params = new URLSearchParams(`gate=campaign_choice:${PICK}`)
    fresh()
    await waitFor(() => expect(screen.getByRole('button', { name: /UK agents/, pressed: true })).toBeTruthy())
    const panel = await detail()
    expect(within(panel).getByRole('heading', { name: 'Campaign' })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Cancel push' })).toBeTruthy()
    // Exactly one "Cancel push" on the page: the run's buttons live nowhere else.
    expect(screen.getAllByRole('button', { name: 'Cancel push' })).toHaveLength(1)
    const side = screen.getByRole('region', { name: 'Also needs you' })
    expect(within(side).queryByRole('button', { name: 'Cancel push' })).toBeNull()
    // Gates outside any run keep their buttons in the side list.
    expect(within(side).getByRole('group', { name: /Job scrape review: GTM batch/ })).toBeTruthy()
    expect(within(side).getByRole('button', { name: 'Reviewed, pull' })).toBeTruthy()
  })

  it('a closed gate link still opens its run, with a note', async () => {
    nav.params = new URLSearchParams(`gate=campaign_choice:${DONE}`)
    fresh()
    await waitFor(() => expect(screen.getByRole('button', { name: /Finished list/, pressed: true })).toBeTruthy())
    expect(await screen.findByText('This gate is already closed — handled here or in Telegram.')).toBeTruthy()
  })

  it('another run waiting on you shows in Also needs you as "Open run", without its buttons', async () => {
    queue.gates = [gate('push_review', PICK)]
    nav.params = new URLSearchParams(`run=${DONE}`)
    fresh()
    const side = await screen.findByRole('region', { name: 'Also needs you' })
    const open = await within(side).findByRole('button', { name: /UK agents.*Open run/ })
    expect(within(side).queryByRole('button', { name: 'Push these' })).toBeNull()
    fireEvent.click(open)
    expect(nav.replace).toHaveBeenCalledWith(`/progress?run=${PICK}`, { scroll: false })
  })

  it('other activity: non-CSV processes only, collapsed under one line', async () => {
    progress = {
      running: [
        item({ key: 'apify:r1', title: 'compass/crawler', done: 120, cost_usd: 0.42 }),
        item({ key: `validation:${RUNNING}`, kind: 'validation', label: 'Validation', title: 'PM leads', job_id: RUNNING }),
      ],
      recent: [],
    }
    fresh()
    const other = await screen.findByRole('region', { name: 'Other activity' })
    expect(within(other).getByRole('group', { name: 'Apify run: compass/crawler' }).textContent).toContain('120 so far · $0.42 so far · started 2h ago')
    expect(within(other).queryByRole('group', { name: /Validation:/ })).toBeNull()
  })

  it('nothing at all: one empty state', async () => {
    runs = []
    fresh()
    expect(await screen.findByText('Nothing running, nothing waiting on you.')).toBeTruthy()
  })
})
