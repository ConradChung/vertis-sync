import { fetchJson } from '@/hooks/fetcher'
import { leadBankSearchParams } from '@/lib/db/leadBankQuery'

/**
 * The SWR keys each tab reads on first paint — exactly the keys its hooks
 * build with their defaults, so a warmed entry is a cache hit on arrival.
 * Detail views (a job's rows, one campaign's flow) are not warmed.
 */
export const TAB_KEYS: Record<string, readonly string[]> = {
  '/overview': ['/api/overview', '/api/overview/instantly'],
  '/import': ['/api/orders?limit=100'],
  '/validate': ['/api/gates', '/api/instantly/campaigns'],
  '/rotate': [`/api/lead-bank${leadBankSearchParams({ filter: {}, page: 1, pageSize: 100 })}`, '/api/rules', '/api/campaigns'],
  '/campaigns': ['/api/campaigns?with=analytics'],
  '/crm': ['/api/crm/board?campaign=all'],
  '/playground': ['/api/playground/diagrams', '/api/agent/skills', '/api/campaigns?with=analytics'],
}

/** A key warmed this recently is not fetched again by hover or idle passes. */
export const WARM_MS = 30_000

export interface PrefetchDeps {
  /** SWR's mutate (global or from useSWRConfig): writes data into the cache. */
  mutate: (key: string, data: Promise<unknown>, opts: { revalidate: false; populateCache: true; rollbackOnError: true }) => Promise<unknown>
  /** True when the SWR cache already holds data for the key. */
  hasData: (key: string) => boolean
  fetcher?: (key: string) => Promise<unknown>
  now?: () => number
}

const warmedAt = new Map<string, number>()

/**
 * Fill the SWR cache for a tab before the user lands on it. Mounted hooks
 * then render the cached data at once and revalidate in the background (SWR's
 * default revalidate-on-mount), so a warmed entry is never served stale
 * without a refresh. Failures leave the cache untouched; the page fetches as
 * usual.
 */
export function prefetchTab(href: string, deps: PrefetchDeps): string[] {
  const now = (deps.now ?? Date.now)()
  const fetcher = deps.fetcher ?? fetchJson
  const started: string[] = []
  for (const key of TAB_KEYS[href] ?? []) {
    if (deps.hasData(key)) continue
    const last = warmedAt.get(key)
    if (last !== undefined && now - last < WARM_MS) continue
    warmedAt.set(key, now)
    started.push(key)
    deps
      .mutate(key, fetcher(key), { revalidate: false, populateCache: true, rollbackOnError: true })
      .catch(() => warmedAt.delete(key))
  }
  return started
}

/** Test hook: forget what was warmed. */
export function resetPrefetchMemo() {
  warmedAt.clear()
}
