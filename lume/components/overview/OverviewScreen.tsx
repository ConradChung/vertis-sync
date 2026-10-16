'use client'

import { useOverview, useOverviewInstantly } from '@/hooks/useOverview'
import { OverviewView } from '@/components/overview/OverviewView'

/**
 * `/overview`: the database half revalidates on relevant Realtime inserts
 * (throttled); the Instantly half polls every 60 s on its own SWR key.
 */
export function OverviewScreen() {
  const db = useOverview()
  const ins = useOverviewInstantly()
  return (
    <OverviewView
      data={db.data}
      error={db.error}
      onRetry={() => void db.mutate()}
      instantly={ins.data}
      instantlyError={ins.error}
      onRetryInstantly={() => void ins.mutate()}
    />
  )
}
