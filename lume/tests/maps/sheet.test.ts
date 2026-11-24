import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => { throw new Error('no db in tests') } }))
const m = vi.hoisted(() => ({ getRun: vi.fn(), datasetItems: vi.fn(), createList: vi.fn(), appendItems: vi.fn() }))
vi.mock('@/lib/adapters/apify', async (orig) => ({ ...(await orig<object>()), getRun: m.getRun, datasetItems: m.datasetItems }))
vi.mock('@/lib/leads/lists/store', () => ({ createList: m.createList, appendItems: m.appendItems }))

import { ApifyError } from '@/lib/adapters/apify'
import { MapsError } from '@/lib/maps/errors'
import { buildMapsSheet, looksLikeMapsDataset } from '@/lib/maps/sheet'

const RUN = 'AbCdEfGh12345678'
const place = (o: Record<string, unknown> = {}) => ({ title: 'Acme PM', website: 'acmepm.com', phone: '(310) 555-0134', city: 'Santa Monica', totalScore: 4.5, reviewsCount: 10, categoryName: 'Property management company', placeId: 'p1', ...o })

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.getRun.mockResolvedValue({ status: 'SUCCEEDED', datasetId: 'DsDsDsDs1234' })
  m.createList.mockResolvedValue({ id: 'L1', name: 'LA PM · Google Maps · 2026-11-24' })
  m.appendItems.mockResolvedValue({ added: 2, duplicates: 0, skipped: 0, over_cap: 0, item_count: 2 })
})

const code = async (p: Promise<unknown>) => {
  const err = await p.catch((e) => e)
  expect(err).toBeInstanceOf(MapsError)
  return `${(err as MapsError).status} ${(err as MapsError).code}`
}

describe('buildMapsSheet', () => {
  it('a finished run → one new list of the kept companies, nothing else touched', async () => {
    m.datasetItems.mockResolvedValue({ items: [place(), place({ title: 'Bee PM', website: 'beepm.com', placeId: 'p2' }), place({ title: 'Gone', website: null })], truncated: false })
    const out = await buildMapsSheet({ run_id: RUN }, { by: 'owner' })
    expect(m.datasetItems).toHaveBeenCalledWith('DsDsDsDs1234')
    expect(m.createList).toHaveBeenCalledTimes(1)
    const list = m.createList.mock.calls[0][0]
    expect(list.name).toMatch(/^LA PM · Google Maps · \d{4}-\d{2}-\d{2}$/)
    expect(list.created_by).toBe('owner')
    expect(list.notes).toContain(`run ${RUN}`)
    const rows = m.appendItems.mock.calls[0][1]
    expect(m.appendItems.mock.calls[0][0]).toBe('L1')
    expect(rows).toHaveLength(2)
    expect(rows.every((r: { source: string }) => r.source === 'actor_run')).toBe(true)
    expect(out).toMatchObject({ list_id: 'L1', run_status: 'SUCCEEDED', truncated: false, clean: { kept: 2, total: 3, pm_category: 2, with_phone: 2 } })
    expect(out.summary).toContain('1 without a website')
  })

  it('MCP builds are marked mcp; a dataset id skips the run lookup; a custom name is kept', async () => {
    m.datasetItems.mockResolvedValue({ items: [place()], truncated: true })
    const out = await buildMapsSheet({ dataset_id: 'DsDsDsDs1234' }, { by: 'mcp', name: 'Westside test' })
    expect(m.getRun).not.toHaveBeenCalled()
    expect(m.createList.mock.calls[0][0]).toMatchObject({ name: 'Westside test', created_by: 'mcp' })
    expect(m.appendItems.mock.calls[0][1][0].source).toBe('mcp')
    expect(out.truncated).toBe(true)
  })

  it('a timed-out run still builds (partial), noted on the list', async () => {
    m.getRun.mockResolvedValue({ status: 'TIMED-OUT', datasetId: 'DsDsDsDs1234' })
    m.datasetItems.mockResolvedValue({ items: [place()], truncated: false })
    const out = await buildMapsSheet({ run_id: RUN }, { by: 'agent' })
    expect(out.run_status).toBe('TIMED-OUT')
    expect(m.createList.mock.calls[0][0].notes).toContain('partial')
  })

  it('refuses without creating anything', async () => {
    m.getRun.mockResolvedValueOnce({ status: 'RUNNING', datasetId: 'x' })
    expect(await code(buildMapsSheet({ run_id: RUN }, { by: 'owner' }))).toBe('409 run_not_finished: RUNNING')
    m.datasetItems.mockResolvedValueOnce({ items: [], truncated: false })
    expect(await code(buildMapsSheet({ run_id: RUN }, { by: 'owner' }))).toBe('422 empty_dataset')
    m.datasetItems.mockResolvedValueOnce({ items: [{ fullName: 'Ann', email: 'a@b.com' }], truncated: false })
    expect(await code(buildMapsSheet({ run_id: RUN }, { by: 'owner' }))).toBe('422 not_a_maps_dataset')
    m.datasetItems.mockResolvedValueOnce({ items: [place({ website: null })], truncated: false })
    expect(await code(buildMapsSheet({ run_id: RUN }, { by: 'owner' }))).toMatch(/^422 nothing_kept: /)
    m.getRun.mockRejectedValueOnce(new ApifyError('not_found', 404, 'nope'))
    expect(await code(buildMapsSheet({ run_id: RUN }, { by: 'owner' }))).toBe('404 not_found')
    m.getRun.mockRejectedValueOnce(new ApifyError('not_configured', 503, 'no token'))
    expect(await code(buildMapsSheet({ run_id: RUN }, { by: 'owner' }))).toBe('503 apify_not_configured')
    expect(await code(buildMapsSheet({ run_id: 'bad id!' }, { by: 'owner' }))).toBe('400 bad_run_id')
    expect(await code(buildMapsSheet({}, { by: 'owner' }))).toBe('400 pass run_id or dataset_id')
    expect(m.createList).not.toHaveBeenCalled()
    expect(m.appendItems).not.toHaveBeenCalled()
  })
})

describe('looksLikeMapsDataset', () => {
  it('needs Maps-shaped rows in at least half the sample', () => {
    expect(looksLikeMapsDataset([place(), { a: 1 }])).toBe(true)
    expect(looksLikeMapsDataset([place(), { a: 1 }, { b: 2 }])).toBe(false)
    expect(looksLikeMapsDataset([])).toBe(false)
  })
})
