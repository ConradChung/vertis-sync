'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import type { RunRow } from '@/lib/db/types'

export const RUNS_KEY = '/api/validation-jobs/runs?limit=20'
export const runsSearchKey = (q: string) => `/api/validation-jobs/runs?limit=50&q=${encodeURIComponent(q)}`

const LIVE = new Set(['pending', 'processing'])
const anyLive = (d?: { runs: RunRow[] }) => Boolean(d?.runs.some((r) => LIVE.has(r.status ?? '') || r.instantly_status === 'pushing'))

/** Progress's run switcher: the 20 most recently active validation jobs; 10 s while one runs, else 60 s. */
export function useRuns() {
  return useSWR<{ runs: RunRow[] }>(RUNS_KEY, fetchJson, { keepPreviousData: true, refreshInterval: (d) => (anyLive(d) ? 10_000 : 60_000) })
}

/** "More runs": older runs by name (empty query: the 50 most recent). */
export function useRunSearch(q: string | null) {
  return useSWR<{ runs: RunRow[] }>(q === null ? null : runsSearchKey(q), fetchJson, { keepPreviousData: true, revalidateOnFocus: false })
}
