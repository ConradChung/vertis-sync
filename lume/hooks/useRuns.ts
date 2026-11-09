'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import type { RunRow } from '@/lib/db/types'

export const RUNS_KEY = '/api/validation-jobs/runs?limit=100'

const LIVE = new Set(['pending', 'processing'])
const anyLive = (d?: { runs: RunRow[] }) => Boolean(d?.runs.some((r) => LIVE.has(r.status ?? '') || r.instantly_status === 'pushing'))

/** Progress's CSV picker: validation jobs from the last 4 months, newest first; 10 s while one runs, else 60 s. */
export function useRuns() {
  return useSWR<{ runs: RunRow[] }>(RUNS_KEY, fetchJson, { keepPreviousData: true, refreshInterval: (d) => (anyLive(d) ? 10_000 : 60_000) })
}

