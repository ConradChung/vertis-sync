'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import type { RuleView } from '@/lib/rules/view'

/**
 * Rotation rules from `GET /api/rules`, with their awaiting actions.
 * Revalidates on pending_actions changes (an activation confirmed or a rule
 * firing) and on the feed.
 */
export function useRules() {
  const swr = useSWR<RuleView[]>('/api/rules', fetchJson, { refreshInterval: 60_000, keepPreviousData: true })
  useRealtimeInvalidate(() => void swr.mutate(), { tables: ['events', 'pending_actions'] })
  return swr
}
