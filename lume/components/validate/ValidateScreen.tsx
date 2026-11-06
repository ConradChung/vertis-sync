'use client'

import { useSearchParams } from 'next/navigation'
import { useValidationQueue } from '@/hooks/useValidationQueue'
import { RunningJobs } from '@/components/validate/RunningJobs'
import { ValidationHistory } from '@/components/validate/ValidationHistory'
import { ValidateView } from '@/components/validate/ValidateView'

/**
 * `/validate`: running / recently finished validation jobs (read-only), then
 * the gate queue (SWR + Realtime) and the `?gate=` deep link. The Running
 * section shows even when no gate waits, so a long job is never just
 * "Nothing waiting on you".
 */
export function ValidateScreen() {
  const q = useValidationQueue()
  const params = useSearchParams()
  return (
    <div className="flex flex-col gap-5">
      <RunningJobs />
      <ValidationHistory />
      <ValidateView gates={q.data} error={q.error} onRefresh={() => void q.mutate()} deepLink={params.get('gate')} />
    </div>
  )
}
