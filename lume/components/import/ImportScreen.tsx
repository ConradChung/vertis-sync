'use client'

import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from '@/lib/motion'
import { OrderRail } from '@/components/import/OrderRail'
import { OrdersTable } from '@/components/import/OrdersTable'
import { SourceCards } from '@/components/import/SourceCards'
import { useOrders } from '@/hooks/useOrders'
import type { OrderKind } from '@/lib/db/types'

type Selection = { kind: OrderKind; id: string }

/** `/import`: the three intakes, the orders table (SWR + Realtime), the order rail. */
export function ImportScreen() {
  const q = useOrders()
  const [selected, setSelected] = useState<Selection | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const [tick, setTick] = useState(0)

  // On a single column (phones) the rail sits under the table: bring it into view.
  useEffect(() => {
    if (!selected || tick === 0) return
    const el = railRef.current
    if (el && typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1023px)').matches) {
      el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    }
  }, [tick, selected, reduce])

  const select = (s: Selection) => {
    setSelected(s)
    setTick((t) => t + 1)
  }

  return (
    <div className="flex flex-col gap-5">
      <SourceCards
        onCreated={(o) => {
          void q.mutate()
          select(o)
        }}
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <OrdersTable orders={q.data} error={q.error} selected={selected} onSelect={select} onRetry={() => void q.mutate()} />
        <div ref={railRef} className="min-w-0 scroll-mt-24 lg:sticky lg:top-[96px]">
          <OrderRail selected={selected} onClose={() => setSelected(null)} onChanged={() => void q.mutate()} />
        </div>
      </div>
    </div>
  )
}
