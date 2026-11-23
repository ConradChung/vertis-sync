'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import type { ApprovalItem } from '@/lib/approvals/view'

export const PENDING_KEY = '/api/actions/pending'
export const PENDING_POLL_MS = 30_000

export interface PendingResponse {
  count: number
  items: ApprovalItem[]
}

/**
 * Every awaiting pending action (`GET /api/actions/pending`): polled every
 * 30 s and refetched on pending_actions changes. The nav badge and the
 * Approvals list share this one SWR key.
 */
export function usePendingActions(opts: { fallbackData?: PendingResponse } = {}) {
  const swr = useSWR<PendingResponse>(PENDING_KEY, fetchJson, {
    refreshInterval: PENDING_POLL_MS,
    revalidateOnFocus: true,
    ...(opts.fallbackData ? { fallbackData: opts.fallbackData } : {}),
  })
  useRealtimeInvalidate(() => void swr.mutate(), { tables: ['pending_actions'] })
  return swr
}

/** The pending count for the nav badge; 0 while loading or on an error (no badge). */
export function usePendingCount(): number {
  const { data } = usePendingActions()
  return data?.count ?? 0
}
