'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import type { OverviewPayload } from '@/lib/overview/types'

/**
 * Overview KPIs, recent events and scheduled jobs from `GET /api/overview`.
 * Revalidates on every new `events` row (replies, bounces, decisions) and on
 * `pending_actions` changes (the pending-gates tile), plus a slow poll for
 * the cron countdowns.
 */
export function useOverview() {
  const swr = useSWR<OverviewPayload>('/api/overview', fetchJson, {
    refreshInterval: 60_000,
    keepPreviousData: true,
  })
  useRealtimeInvalidate(() => void swr.mutate(), { tables: ['events', 'pending_actions', 'agent_runs'] })
  return swr
}
