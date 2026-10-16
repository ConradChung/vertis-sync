'use client'

import { useSearchParams } from 'next/navigation'
import { useValidationQueue } from '@/hooks/useValidationQueue'
import { ValidateView } from '@/components/validate/ValidateView'

/** `/validate`: the gate queue (SWR + Realtime) and the `?gate=` deep link. */
export function ValidateScreen() {
  const q = useValidationQueue()
  const params = useSearchParams()
  return <ValidateView gates={q.data} error={q.error} onRefresh={() => void q.mutate()} deepLink={params.get('gate')} />
}
