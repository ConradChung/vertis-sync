'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import type { OrderRow } from '@/lib/db/types'

/** Import & Orders table from `GET /api/orders`; revalidates on new events (ingests, jobs, batches). */
export function useOrders({ limit = 100 }: { limit?: number } = {}) {
  const swr = useSWR<OrderRow[]>(`/api/orders?limit=${limit}`, fetchJson, { keepPreviousData: true })
  useRealtimeInvalidate(() => void swr.mutate())
  return swr
}
