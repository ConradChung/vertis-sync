import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TAB_KEYS, WARM_MS, prefetchTab, resetPrefetchMemo } from '@/lib/prefetch/tabs'
import { TABS } from '@/components/shell/TopBar'

describe('prefetchTab', () => {
  beforeEach(() => resetPrefetchMemo())

  const deps = (over: Partial<Parameters<typeof prefetchTab>[1]> = {}) => ({
    mutate: vi.fn(async () => undefined),
    hasData: vi.fn(() => false),
    fetcher: vi.fn(async (k: string) => ({ k })),
    now: () => 1_000,
    ...over,
  })

  it('warms every key of the tab into the SWR cache without a second revalidation', () => {
    const d = deps()
    expect(prefetchTab('/rotate', d)).toEqual([...TAB_KEYS['/rotate']])
    expect(d.mutate).toHaveBeenCalledTimes(3)
    expect(d.mutate).toHaveBeenCalledWith('/api/rules', expect.any(Promise), { revalidate: false, populateCache: true, rollbackOnError: true })
    expect(d.fetcher).toHaveBeenCalledWith('/api/lead-bank')
  })

  it('skips keys already cached and keys warmed recently', () => {
    const d = deps({ hasData: (k: string) => k === '/api/overview' })
    expect(prefetchTab('/overview', d)).toEqual(['/api/overview/instantly'])
    expect(prefetchTab('/overview', d)).toEqual([])
    expect(prefetchTab('/overview', { ...d, now: () => 1_000 + WARM_MS + 1 })).toEqual(['/api/overview/instantly'])
  })

  it('forgets a failed warm so the next hover retries', async () => {
    const d = deps({ mutate: vi.fn(async () => Promise.reject(new Error('500'))) })
    prefetchTab('/crm', d)
    await new Promise((r) => setTimeout(r, 0))
    expect(prefetchTab('/crm', d)).toEqual(['/api/crm/board?campaign=all'])
  })

  it('ignores unknown tabs and the agent tab', () => {
    expect(prefetchTab('/agent', deps())).toEqual([])
    expect(prefetchTab('/nope', deps())).toEqual([])
  })

  it('covers every data tab in the bar', () => {
    for (const t of TABS) if (t.href !== '/agent') expect(TAB_KEYS[t.href], t.href).toBeDefined()
  })
})
