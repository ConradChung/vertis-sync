'use client'

import { useOverview } from '@/hooks/useOverview'
import { OverviewView } from '@/components/overview/OverviewView'

/** `/overview`: SWR over `/api/overview`, revalidated by Realtime inserts (see `useOverview`). */
export function OverviewScreen() {
  const { data, error, mutate } = useOverview()
  return <OverviewView data={data} error={error} onRetry={() => void mutate()} />
}
