'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import type { GateRow } from '@/lib/db/types'

/**
 * Open gates from `GET /api/gates` (the `lume_gates` view). Revalidates on
 * new events (every gate open/close writes one via the DB triggers) and on
 * `pending_actions` inserts/updates (the `lume_action` kind). A short poll
 * covers the case where a trigger is silent.
 */
export function useValidationQueue() {
  const swr = useSWR<GateRow[]>('/api/gates', fetchJson, {
    refreshInterval: 30_000,
    keepPreviousData: true,
  })
  useRealtimeInvalidate(() => void swr.mutate(), { tables: ['events', 'pending_actions'] })
  return swr
}
