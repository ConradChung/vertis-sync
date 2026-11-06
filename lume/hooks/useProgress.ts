'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import { pollInterval, type ProgressPayload } from '@/lib/progress/model'

export const PROGRESS_KEY = '/api/progress'

/** The Progress queue: every 5 s while anything runs, else every 60 s. */
export function useProgress() {
  return useSWR<ProgressPayload>(PROGRESS_KEY, fetchJson, { keepPreviousData: true, refreshInterval: pollInterval })
}
