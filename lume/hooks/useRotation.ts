'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import { leadBankSearchParams, type LeadBankFilter } from '@/lib/db/leadBankQuery'
import type { LeadBankRow } from '@/lib/db/types'

export interface LeadBankPageResponse {
  rows: LeadBankRow[]
  total: number
  page: number
  pageSize: number
}

/**
 * Rotate screen's lead bank from `GET /api/lead-bank` (paged, filtered on the
 * server). Revalidates on new events: `assign_leads` executions and finished
 * validation jobs both land in the feed.
 */
export function useRotation({
  filter = {},
  page = 1,
  pageSize = 100,
}: { filter?: LeadBankFilter; page?: number; pageSize?: number } = {}) {
  const key = `/api/lead-bank${leadBankSearchParams({ filter, page, pageSize })}`
  const swr = useSWR<LeadBankPageResponse>(key, fetchJson, { keepPreviousData: true })
  useRealtimeInvalidate(() => void swr.mutate(), { tables: ['events', 'pending_actions'] })
  return swr
}
