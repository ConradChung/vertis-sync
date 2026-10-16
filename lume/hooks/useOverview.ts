'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import { useRealtimeInvalidate, type RealtimeChange } from '@/hooks/useRealtimeInvalidate'
import type { OverviewInstantly, OverviewPayload } from '@/lib/overview/types'

const SHOWN_EVENT_TYPES = new Set(['reply', 'interested', 'bounce'])

/** Only `events` the Overview shows (feed, agent activity, gate pings); every `pending_actions` change. */
export function overviewRelevant({ table, record }: RealtimeChange): boolean {
  if (table !== 'events') return true
  const type = typeof record.type === 'string' ? record.type : ''
  return SHOWN_EVENT_TYPES.has(type) || type.startsWith('agent.') || type.startsWith('lume.')
}

/**
 * Database half of the Overview (`GET /api/overview`). Revalidates on
 * Realtime inserts the page shows, at most once per 5 s, plus a slow poll.
 * Event types it never renders (rotation runs, sends) do not refetch.
 */
export function useOverview() {
  const swr = useSWR<OverviewPayload>('/api/overview', fetchJson, {
    refreshInterval: 60_000,
    keepPreviousData: true,
  })
  useRealtimeInvalidate(() => void swr.mutate(), {
    tables: ['events', 'pending_actions'],
    filter: overviewRelevant,
    throttleMs: 5_000,
  })
  return swr
}

/** Instantly half (`GET /api/overview/instantly`): a 60 s poll, never Realtime-driven. */
export function useOverviewInstantly() {
  return useSWR<OverviewInstantly>('/api/overview/instantly', fetchJson, {
    refreshInterval: 60_000,
    keepPreviousData: true,
    revalidateOnFocus: false,
  })
}
