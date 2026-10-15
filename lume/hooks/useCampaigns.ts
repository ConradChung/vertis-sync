'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import type { LumeCampaignRow } from '@/lib/db/types'

/**
 * Campaign registry from `GET /api/campaigns` (`lume_campaigns`). Instantly
 * analytics are merged in by Task 13. Revalidates on events (a sync or a
 * pause/resume execution logs one).
 */
export function useCampaigns() {
  const swr = useSWR<LumeCampaignRow[]>('/api/campaigns', fetchJson, {
    refreshInterval: 120_000,
    keepPreviousData: true,
  })
  useRealtimeInvalidate(() => void swr.mutate())
  return swr
}
