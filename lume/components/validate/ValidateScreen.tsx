'use client'

import { useSearchParams } from 'next/navigation'
import { useValidationQueue } from '@/hooks/useValidationQueue'
import { useProgress } from '@/hooks/useProgress'
import { RunningNow } from '@/components/progress/RunningNow'
import { ValidationHistory } from '@/components/validate/ValidationHistory'
import { ValidateView } from '@/components/validate/ValidateView'

/**
 * `/progress` (was /validate): "Running now" — one queue of every live
 * process (validation jobs, Apify runs, influencer runs and lookups,
 * Leadsfriday orders, job-search batches) and the last 24 h's finished ones —
 * then the validation history and "Waiting on you", the gate queue (SWR +
 * Realtime) with the `?gate=` deep link.
 */
export function ValidateScreen() {
  const q = useValidationQueue()
  const progress = useProgress()
  const params = useSearchParams()
  const idle = progress.data ? progress.data.running.length === 0 : false
  return (
    <div className="flex flex-col gap-5">
      <RunningNow data={progress.data} />
      <ValidationHistory />
      <section aria-label="Waiting on you" className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold text-fg">Waiting on you</h2>
        <ValidateView
          gates={q.data}
          error={q.error}
          onRefresh={() => void q.mutate()}
          deepLink={params.get('gate')}
          emptyText={idle ? 'Nothing running, nothing waiting on you.' : 'Nothing waiting on you'}
        />
      </section>
    </div>
  )
}
