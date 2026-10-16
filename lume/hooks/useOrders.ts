'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import type { OrderKind, OrderRow } from '@/lib/db/types'
import type { OrderDetail } from '@/lib/import/orderDetail'

/** Import & Orders table from `GET /api/orders`; revalidates on new events (ingests, jobs, batches). */
export function useOrders({ limit = 100 }: { limit?: number } = {}) {
  const swr = useSWR<OrderRow[]>(`/api/orders?limit=${limit}`, fetchJson, { keepPreviousData: true })
  useRealtimeInvalidate(() => void swr.mutate(), { throttleMs: 5000 })
  return swr
}

/** One order's detail (`?id=&kind=`); `null` selection → no request. */
export function useOrderDetail(sel: { kind: OrderKind; id: string } | null) {
  const key = sel ? `/api/orders?id=${encodeURIComponent(sel.id)}&kind=${sel.kind}` : null
  const swr = useSWR<OrderDetail>(key, fetchJson)
  useRealtimeInvalidate(() => void swr.mutate(), { enabled: key !== null, throttleMs: 5000 })
  return swr
}
