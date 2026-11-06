import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memdb } from '../stubs/memdb'

let db = memdb({})
const ap = vi.hoisted(() => ({ isApifyConfigured: vi.fn(), listAccountRuns: vi.fn(), getRun: vi.fn() }))
const svc = vi.hoisted(() => ({ listRecentJobs: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db.client }))
vi.mock('@/lib/adapters/apify', () => ap)
vi.mock('@/lib/db/service', () => svc)
vi.mock('@/lib/leads/lists/influencerSheets', () => ({ sheetsForBatches: async () => new Map([['b1', 'list-1']]) }))

import { buildProgress, MAX_LIVE_APIFY } from '@/lib/progress/build'

const NOW = new Date('2026-11-06T12:00:00Z')
const iso = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000).toISOString()
const accountRun = (id: string, status: string, o: Record<string, unknown> = {}) => ({ run_id: id, actor_id: 'a/b', status, started_at: iso(10), finished_at: null, dataset_id: null, cost_usd: 0.1, console_url: `https://console/${id}`, ...o })

beforeEach(() => {
  vi.clearAllMocks()
  db = memdb({})
  ap.isApifyConfigured.mockReturnValue(true)
  ap.listAccountRuns.mockResolvedValue([])
  ap.getRun.mockReset()
  svc.listRecentJobs.mockResolvedValue([{ id: 'j1', filename: 'pm.csv', status: 'processing', total_rows: 100, processed_rows: 40, created_at: iso(30), updated_at: iso(1), error_message: null }])
})

describe('buildProgress', () => {
  it('gathers every source into one queue (running newest first)', async () => {
    db.table('influencer_runs').push({ id: 'ir', status: 'running', stage: 'posts', influencer_ids: ['a'], cost: {}, counts: {}, error: null, created_at: iso(20), updated_at: iso(1), finished_at: null })
    db.table('influencer_candidate_batches').push({ id: 'b1', name: 'PM', status: 'looking_up', spent_usd: 0.2, max_lookup_usd: 1, error: null, created_at: iso(5), updated_at: iso(1) })
    db.table('influencer_candidates').push({ batch_id: 'b1', status: 'found' }, { batch_id: 'b1', status: 'pending_lookup' })
    db.table('apollo_orders').push({ id: 'o', status: 'ordered', contact_count: 500, leadsfriday_status: 'processing', error: null, created_at: iso(60), updated_at: iso(2) })
    db.table('job_batches').push({ id: 'jb', status: 'resolving', batch_date: '2026-11-06', companies_pulled: 10, companies_added: 3, contacts_total: null, error: null, created_at: iso(90), updated_at: iso(2) })
    const out = await buildProgress(NOW)
    expect(out.running.map((i) => i.key)).toEqual(['influencer_lookup:b1', 'influencer_run:ir', 'validation:j1', 'leadsfriday_order:o', 'job_batch:jb'])
    expect(out.running[0]).toMatchObject({ done: 1, total: 2, href: '/import/leads?list=list-1' })
    expect(out.unavailable).toBeUndefined()
  })

  it('Apify: getRun only for live runs, at most 10; finished runs from the list need no call; a failing getRun keeps the list row', async () => {
    const live = Array.from({ length: 12 }, (_, i) => accountRun(`r${i}`, 'RUNNING'))
    ap.listAccountRuns.mockResolvedValue([...live, accountRun('done', 'SUCCEEDED', { finished_at: iso(30) })])
    ap.getRun.mockImplementation(async (id: string) => {
      if (id === 'r0') throw new Error('429')
      return { id, actorId: 'a/b', status: 'RUNNING', statusMessage: null, startedAt: iso(10), finishedAt: null, usageTotalUsd: 0.5, itemCount: 42, consoleUrl: `https://console/${id}` }
    })
    const out = await buildProgress(NOW)
    expect(ap.getRun).toHaveBeenCalledTimes(MAX_LIVE_APIFY)
    const apify = out.running.filter((i) => i.kind === 'apify')
    expect(apify).toHaveLength(12)
    expect(apify.find((i) => i.key === 'apify:r1')).toMatchObject({ done: 42, cost_usd: 0.5 })
    expect(apify.find((i) => i.key === 'apify:r0')).toMatchObject({ done: null, cost_usd: 0.1 })
    expect(out.recent.map((i) => i.key)).toContain('apify:done')
  })

  it('a source that fails is listed as unavailable; the rest still show', async () => {
    ap.listAccountRuns.mockRejectedValue(new Error('down'))
    const out = await buildProgress(NOW)
    expect(out.unavailable).toEqual(['apify'])
    expect(out.running.map((i) => i.key)).toEqual(['validation:j1'])
  })

  it('Apify not configured: no calls', async () => {
    ap.isApifyConfigured.mockReturnValue(false)
    await buildProgress(NOW)
    expect(ap.listAccountRuns).not.toHaveBeenCalled()
  })
})
