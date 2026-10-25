'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import type { LumeCampaignRow } from '@/lib/db/types'

/** `GET /api/campaigns` row: the registry plus queue depth and the rotator flag. */
export type CampaignView = LumeCampaignRow & { queued: number; rotator: boolean }

/**
 * Campaign registry from `GET /api/campaigns` (`lume_campaigns` + `queued`
 * lead_bank depth + `rotator`). Instantly
 * analytics are merged in by Task 13. Revalidates on events (a sync or a
 * pause/resume execution logs one).
 */
export function useCampaigns() {
  const swr = useSWR<CampaignView[]>('/api/campaigns', fetchJson, {
    refreshInterval: 120_000,
    keepPreviousData: true,
  })
  useRealtimeInvalidate(() => void swr.mutate())
  return swr
}
