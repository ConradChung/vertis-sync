'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import type { CrmBoardResponse, CrmDealDetail } from '@/lib/crm/types'

const CRM_EVENT = (t: unknown) =>
  typeof t === 'string' && (t === 'reply' || t === 'interested' || t === 'bounce' || t === 'sent' || t.startsWith('lume.crm') || t.startsWith('lume.action.'))

/** CRM board for one campaign or 'all'; revalidates on webhook events and approvals. */
export function useCrmBoard(campaign: string | null) {
  const key = campaign ? `/api/crm/board?campaign=${encodeURIComponent(campaign)}` : null
  const swr = useSWR<CrmBoardResponse>(key, fetchJson, { refreshInterval: 60_000, keepPreviousData: true })
  useRealtimeInvalidate(() => void swr.mutate(), {
    tables: ['events', 'pending_actions'],
    enabled: key !== null,
    throttleMs: 2_000,
    filter: (c) => c.table === 'pending_actions' || CRM_EVENT(c.record.type),
  })
  return swr
}

export function useCrmDeal(id: string | null) {
  const swr = useSWR<CrmDealDetail>(id ? `/api/crm/deals/${id}` : null, fetchJson, { keepPreviousData: false })
  useRealtimeInvalidate(() => void swr.mutate(), {
    tables: ['events', 'pending_actions'],
    enabled: id !== null,
    throttleMs: 2_000,
    filter: (c) => c.table === 'pending_actions' || CRM_EVENT(c.record.type),
  })
  return swr
}
